//go:build windows

package main

// DXGI Desktop Duplication 抓屏：GPU 合成后的整帧，比 GDI BitBlt 更接近用户看到的画面。
//
// 与 Nova 的 jianlai/dxgi.rs 对齐：任何一个环节失败（旋转输出、HDR 格式、安全桌面、会话限制、
// 其它采集程序占用）都返回错误，由调用方回退到 GDI——绝不返回半黑或未初始化的图。
//
// shortcut: COM vtable 直调（CGO_ENABLED=0 不能引 d3d11 绑定）。槽位按公开头文件顺序写死，
// 用 --grab-preview 与 GDI 逐像素比对来自检；D3D 头文件一变就必须重跑那个自检。

import (
	"fmt"
	"image"
	"sync"
	"syscall"
	"unsafe"
)

var (
	dxgiD3D11Lib = syscall.NewLazyDLL("d3d11.dll")
	dxgiDXGILib  = syscall.NewLazyDLL("dxgi.dll")

	procD3D11CreateDevice  = dxgiD3D11Lib.NewProc("D3D11CreateDevice")
	procCreateDXGIFactory1 = dxgiDXGILib.NewProc("CreateDXGIFactory1")
)

// COM IID 按内存布局直接写，避免额外依赖。
type dxgiIID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	// IID 取自 windows-rs define_interface!（按内存布局写，Data1..Data3 小端）。
	iidDXGIFactory1 = dxgiIID{0x770aae78, 0xf26f, 0x4dba, [8]byte{0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87}}
	iidDXGIOutput1  = dxgiIID{0x00cddea8, 0x939b, 0x4b83, [8]byte{0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc}}
	iidTexture2D    = dxgiIID{0x6f15aaf2, 0xd208, 0x4e89, [8]byte{0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}}
)

// vtable 槽位（IUnknown 占 0/1/2）。
const (
	comReleaseSlot = 2

	// IDXGIFactory1：IUnknown 3 + IDXGIObject 4 → EnumAdapters=7，EnumAdapters1=12。
	dxgiEnumAdapters1Slot = 12
	// IDXGIAdapter（IDXGIObject 之后）：EnumOutputs=7。
	dxgiEnumOutputsSlot = 7
	// IDXGIOutput1：DuplicateOutput 在公开头文件里是第 22 槽。
	dxgiDuplicateOutputSlot = 22
	// ID3D11Device：CreateTexture2D 在 IUnknown 之后第 5 槽。
	d3dCreateTexture2DSlot = 5
	// ID3D11Texture2D：DeviceChild 4 + Resource 3 → GetDesc=10。
	d3dTextureGetDescSlot = 10
	// ID3D11DeviceContext：IUnknown 3 + ID3D11DeviceChild 4 → Map=14、Unmap=15、CopyResource=47。
	d3dContextMapSlot          = 14
	d3dContextUnmapSlot        = 15
	d3dContextCopyResourceSlot = 47
	// IDXGIOutputDuplication：IDXGIObject 之后 GetDesc=7、AcquireNextFrame=8、ReleaseFrame=14。
	dxgiAcquireNextFrameSlot = 8
	dxgiReleaseFrameSlot     = 14
)

const (
	dxgiFormatB8G8R8A8Unorm = 87
	d3dDriverTypeUnknown    = 0 // D3D_DRIVER_TYPE_UNKNOWN：传了 adapter 就必须用它，否则 E_INVALIDARG
	d3d11SdkVersion         = 7
	d3d11UsageStaging       = 3
	d3d11CpuAccessRead      = 0x20000
	d3d11MapRead            = 1
	dxgiErrorWaitTimeout    = 0x887A0027
	dxgiErrorAccessLost     = 0x887A0026
	dxgiErrorNotAvailable   = 0x887A0022 // 已有其它程序在抓这块屏幕
	dxgiAcquireTimeoutMs    = 18
	// 单次 Acquire 最多排空这么多次仅鼠标更新帧，避免漏掉后面的真实桌面帧。
	dxgiFrameAttempts = 16
)

const (
	dxgiStatusFresh = iota + 1
	dxgiStatusNoUpdate
	dxgiStatusUnsupported
)

// comCall 调某个接口的第 index 个 vtable 槽。
func comCall(pointer unsafe.Pointer, index int, args ...uintptr) uintptr {
	vtable := *(*unsafe.Pointer)(pointer)
	slot := (*[128]uintptr)(vtable)[index]
	call := append([]uintptr{uintptr(pointer)}, args...)
	result, _, _ := syscall.SyscallN(slot, call...)
	return result
}

func comRelease(pointer unsafe.Pointer) {
	if pointer == nil {
		return
	}
	comCall(pointer, comReleaseSlot)
}

func comQuery(pointer unsafe.Pointer, iid *dxgiIID) unsafe.Pointer {
	var out unsafe.Pointer
	hr := comCall(pointer, 0, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))
	if int32(hr) < 0 {
		return nil
	}
	return out
}

type dxgiTextureDesc struct {
	Width     uint32
	Height    uint32
	MipLevels uint32
	ArraySize uint32
	Format    uint32
	SampleCnt uint32
	SampleQ   uint32
	Usage     uint32
	BindFlags uint32
	CPUFlags  uint32
	MiscFlags uint32
}

type dxgiMapped struct {
	Data       unsafe.Pointer
	RowPitch   uint32
	DepthPitch uint32
}

type dxgiRectKey struct {
	x, y int32
	w, h uint32
}

// dxgiCapture 是一条可复用的采集链路（含可复用 staging 纹理与最近一帧基线）；每帧重建设备代价太高。
type dxgiCapture struct {
	device    unsafe.Pointer
	context   unsafe.Pointer
	dup       unsafe.Pointer
	staging   unsafe.Pointer
	stagingW  uint32
	stagingH  uint32
	lastFrame *image.RGBA
	monitor   uint32
	width     uint32
	height    uint32
}

var (
	dxgiPoolMu sync.Mutex
	dxgiPool   = map[dxgiRectKey]*dxgiCapture{}
)

// dxgiGrab 非阻塞式 Desktop Duplication 抓屏：
// - 返回 (img, nil)：拿到最新 GPU 帧或热会话缓存的静止帧；
// - 返回 (nil, nil)：冷静止屏（会话已留在池中预热）或不支持的格式，调用方走 GDI 后调用 dxgiSeedCache；
// - 返回 (nil, err)：D3D11/DXGI 异常，调用方回退 GDI。
func dxgiGrab(surface appuseSurface) (*image.RGBA, error) {
	dxgiPoolMu.Lock()
	defer dxgiPoolMu.Unlock()
	key := dxgiRectKey{x: surface.X, y: surface.Y, w: surface.W, h: surface.H}
	if capture, ok := dxgiPool[key]; ok {
		if capture.monitor != surface.ID {
			delete(dxgiPool, key)
			dxgiCloseCapture(capture)
		} else {
			frame, status, err := dxgiAcquireLatest(capture, 0)
			switch {
			case err != nil:
				// DXGI_ERROR_ACCESS_LOST / 分辨率切换 / 锁屏：丢弃旧会话并重建一次。
				delete(dxgiPool, key)
				dxgiCloseCapture(capture)
			case status == dxgiStatusFresh:
				return frame, nil
			case status == dxgiStatusNoUpdate:
				if capture.lastFrame != nil {
					return appuseCloneRGBA(capture.lastFrame), nil
				}
				return nil, nil
			case status == dxgiStatusUnsupported:
				delete(dxgiPool, key)
				dxgiCloseCapture(capture)
				return nil, nil
			}
		}
	}

	capture, err := dxgiOpenCapture(surface)
	if err != nil {
		return nil, err
	}
	frame, status, err := dxgiAcquireLatest(capture, dxgiAcquireTimeoutMs)
	switch {
	case err != nil || status == dxgiStatusUnsupported:
		dxgiCloseCapture(capture)
		return nil, err
	case status == dxgiStatusFresh:
		dxgiPool[key] = capture
		return frame, nil
	default:
		// 冷静止屏：把已打开的会话留在池中，下次再抓即可直接命中。
		dxgiPool[key] = capture
		return nil, nil
	}
}

// dxgiSeedCache 在冷静止屏走 GDI 抓到基线帧后写入热会话缓存；先排空一次 DXGI，确保较新的 GPU 帧优先。
func dxgiSeedCache(surface appuseSurface, img *image.RGBA) {
	if img == nil || img.Bounds().Dx() != int(surface.W) || img.Bounds().Dy() != int(surface.H) {
		return
	}
	dxgiPoolMu.Lock()
	defer dxgiPoolMu.Unlock()
	key := dxgiRectKey{x: surface.X, y: surface.Y, w: surface.W, h: surface.H}
	capture, ok := dxgiPool[key]
	if !ok {
		return
	}
	_, status, err := dxgiAcquireLatest(capture, 0)
	if err != nil || status == dxgiStatusUnsupported {
		delete(dxgiPool, key)
		dxgiCloseCapture(capture)
		return
	}
	if status == dxgiStatusNoUpdate && capture.lastFrame == nil {
		capture.lastFrame = appuseCloneRGBA(img)
	}
}

func dxgiCloseCapture(capture *dxgiCapture) {
	if capture == nil {
		return
	}
	comRelease(capture.staging)
	comRelease(capture.dup)
	comRelease(capture.context)
	comRelease(capture.device)
}

// dxgiOpenCapture 建 D3D11 设备与对应输出的 duplication。
func dxgiOpenCapture(surface appuseSurface) (*dxgiCapture, error) {
	var factory unsafe.Pointer
	if hr, _, _ := procCreateDXGIFactory1.Call(uintptr(unsafe.Pointer(&iidDXGIFactory1)), uintptr(unsafe.Pointer(&factory))); int32(hr) < 0 || factory == nil {
		return nil, fmt.Errorf("CreateDXGIFactory1 失败（0x%08x）", uint32(hr))
	}
	defer comRelease(factory)
	var adapter unsafe.Pointer
	if hr := comCall(factory, dxgiEnumAdapters1Slot, 0, uintptr(unsafe.Pointer(&adapter))); int32(hr) < 0 || adapter == nil {
		return nil, fmt.Errorf("没有可用的显示适配器")
	}
	defer comRelease(adapter)
	// 显示器序号对应 adapter 的输出序号；多 adapter 时依次找第一个有这个输出的。
	var output unsafe.Pointer
	if hr := comCall(adapter, dxgiEnumOutputsSlot, uintptr(surface.ID), uintptr(unsafe.Pointer(&output))); int32(hr) < 0 || output == nil {
		return nil, fmt.Errorf("显示器 %d 没有 DXGI 输出", surface.ID)
	}
	defer comRelease(output)
	output1 := comQuery(output, &iidDXGIOutput1)
	if output1 == nil {
		return nil, fmt.Errorf("该输出不支持 Desktop Duplication")
	}
	defer comRelease(output1)
	var device, context unsafe.Pointer
	if hr, _, _ := procD3D11CreateDevice.Call(
		uintptr(adapter), d3dDriverTypeUnknown, 0, 0, 0, 0, d3d11SdkVersion,
		uintptr(unsafe.Pointer(&device)), 0, uintptr(unsafe.Pointer(&context))); int32(hr) < 0 || device == nil || context == nil {
		comRelease(context)
		comRelease(device)
		return nil, fmt.Errorf("D3D11CreateDevice 失败（0x%08x）", uint32(hr))
	}
	var dup unsafe.Pointer
	if hr := comCall(output1, dxgiDuplicateOutputSlot, uintptr(device), uintptr(unsafe.Pointer(&dup))); int32(hr) < 0 || dup == nil {
		comRelease(context)
		comRelease(device)
		if code := uint32(hr); code == dxgiErrorAccessLost || code == dxgiErrorNotAvailable {
			return nil, fmt.Errorf("Desktop Duplication 暂不可用（锁屏/安全桌面/其它采集程序）")
		}
		return nil, fmt.Errorf("DuplicateOutput 失败（0x%08x）", uint32(hr))
	}
	return &dxgiCapture{device: device, context: context, dup: dup, monitor: surface.ID, width: surface.W, height: surface.H}, nil
}

// dxgiAcquireLatest 非阻塞（或首帧短等）取一帧最新桌面画面，跳过纯鼠标更新帧。
func dxgiAcquireLatest(capture *dxgiCapture, initialTimeoutMs uint32) (*image.RGBA, int, error) {
	for attempt := 0; attempt < dxgiFrameAttempts; attempt++ {
		timeout := uint32(0)
		if attempt == 0 {
			timeout = initialTimeoutMs
		}
		var info dxgiFrameInfo
		var resource unsafe.Pointer
		hr := comCall(capture.dup, dxgiAcquireNextFrameSlot, uintptr(timeout),
			uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&resource)))
		if int32(hr) < 0 {
			if uint32(hr) == dxgiErrorWaitTimeout {
				return nil, dxgiStatusNoUpdate, nil
			}
			return nil, 0, fmt.Errorf("AcquireNextFrame 失败（0x%08x）", uint32(hr))
		}
		if resource == nil || info.LastPresentTime == 0 {
			// 纯鼠标位置/形状更新不带桌面像素；释放后继续排空队列中的真实帧。
			comRelease(resource)
			comCall(capture.dup, dxgiReleaseFrameSlot)
			continue
		}
		frame, unsupported, err := dxgiReadTexture(capture, resource)
		comCall(capture.dup, dxgiReleaseFrameSlot)
		if err != nil {
			return nil, 0, err
		}
		if unsupported {
			return nil, dxgiStatusUnsupported, nil
		}
		capture.lastFrame = appuseCloneRGBA(frame)
		return frame, dxgiStatusFresh, nil
	}
	return nil, dxgiStatusNoUpdate, nil
}

// dxgiFrameInfo 对应 DXGI_OUTDUPL_FRAME_INFO（含最后的 TotalMetadataBufferSize）。
type dxgiFrameInfo struct {
	LastPresentTime           int64
	LastMouseUpdateTime       int64
	AccumulatedFrames         uint32
	RectsCoalesced            int32
	ProtectedContentMaskedOut int32
	PointerX                  int32
	PointerY                  int32
	PointerVisible            int32
	TotalMetadataBufferSize   uint32
	PointerShapeBufferSize    uint32
}

// dxgiReadTexture 把桌面纹理拷到可复用的 staging 纹理并转成 RGBA。
func dxgiReadTexture(capture *dxgiCapture, resource unsafe.Pointer) (*image.RGBA, bool, error) {
	defer comRelease(resource)
	texture := comQuery(resource, &iidTexture2D)
	if texture == nil {
		return nil, false, fmt.Errorf("桌面资源不是 D3D11 纹理")
	}
	defer comRelease(texture)
	desc := dxgiTextureDesc{}
	if hr := comCall(texture, d3dTextureGetDescSlot, uintptr(unsafe.Pointer(&desc))); int32(hr) < 0 {
		return nil, false, fmt.Errorf("读取纹理描述失败（0x%08x）", uint32(hr))
	}
	if desc.Width == 0 || desc.Height == 0 {
		return nil, true, nil
	}
	if desc.Width != capture.width || desc.Height != capture.height {
		return nil, true, nil
	}
	// 只认 BGRA8：HDR/其它格式交给 GDI，绝不猜通道顺序。
	if desc.Format != dxgiFormatB8G8R8A8Unorm {
		return nil, true, nil
	}
	if capture.staging == nil || capture.stagingW != desc.Width || capture.stagingH != desc.Height {
		comRelease(capture.staging)
		capture.staging = nil
		staging := dxgiTextureDesc{
			Width: desc.Width, Height: desc.Height, MipLevels: 1, ArraySize: 1,
			Format: desc.Format, SampleCnt: 1, Usage: d3d11UsageStaging, CPUFlags: d3d11CpuAccessRead,
		}
		var copyTexture unsafe.Pointer
		if hr := comCall(capture.device, d3dCreateTexture2DSlot,
			uintptr(unsafe.Pointer(&staging)), 0, uintptr(unsafe.Pointer(&copyTexture))); int32(hr) < 0 || copyTexture == nil {
			return nil, false, fmt.Errorf("无法创建回读纹理（0x%08x）", uint32(hr))
		}
		capture.staging = copyTexture
		capture.stagingW = desc.Width
		capture.stagingH = desc.Height
	}
	comCall(capture.context, d3dContextCopyResourceSlot, uintptr(capture.staging), uintptr(texture))
	var mapped dxgiMapped
	if hr := comCall(capture.context, d3dContextMapSlot, uintptr(capture.staging), 0, d3d11MapRead, 0, uintptr(unsafe.Pointer(&mapped))); int32(hr) < 0 || mapped.Data == nil {
		return nil, false, fmt.Errorf("无法映射回读纹理（0x%08x）", uint32(hr))
	}
	defer func() { comCall(capture.context, d3dContextUnmapSlot, uintptr(capture.staging), 0) }()
	width, height, pitch := int(desc.Width), int(desc.Height), int(mapped.RowPitch)
	if pitch < width*4 {
		return nil, false, fmt.Errorf("回读行宽异常（%d < %d）", pitch, width*4)
	}
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	source := unsafe.Slice((*uint8)(mapped.Data), pitch*height)
	for y := 0; y < height; y++ {
		row := source[y*pitch : y*pitch+width*4]
		target := img.Pix[y*img.Stride : y*img.Stride+width*4]
		for x := 0; x < width; x++ {
			b, g, r := row[x*4], row[x*4+1], row[x*4+2]
			target[x*4], target[x*4+1], target[x*4+2], target[x*4+3] = r, g, b, 255
		}
	}
	return img, false, nil
}
