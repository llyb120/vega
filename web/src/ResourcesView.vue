<script setup vapor>
import PageHeader from "./PageHeader.vue";
const clients = [
  { name: "Windows", arch: "x64", file: "vega-local-windows-amd64.exe", description: "系统托盘客户端，无控制台窗口" },
  { name: "Linux", arch: "x64", file: "vega-local-linux-amd64", description: "命令行客户端 · Intel / AMD" },
  { name: "Linux", arch: "ARM64", file: "vega-local-linux-arm64", description: "命令行客户端 · ARM 64 位" },
  { name: "macOS", arch: "Apple Silicon", file: "vega-local-darwin-arm64", description: "命令行客户端 · M 系列芯片" },
  { name: "macOS", arch: "Intel", file: "vega-local-darwin-amd64", description: "命令行客户端 · Intel 芯片" },
];
</script>

<template>
  <PageHeader title="资源" subtitle="下载与当前服务配套的本地客户端和 Chrome 扩展" />
  <div class="page-scroll settings">
    <section aria-labelledby="clients-heading">
      <h3 id="clients-heading">客户端下载</h3>
      <p class="hint">在需要执行任务的电脑上运行客户端，即可使用该电脑的文件、终端和浏览器。手机和平板通过网页选择已授权的在线电脑，无需安装客户端。</p>
      <div class="resource-grid">
        <article v-for="client in clients" :key="client.file" class="card">
          <div class="section-heading"><h3>{{ client.name }}</h3><span class="pill">{{ client.arch }}</span></div>
          <p class="hint">{{ client.description }}</p>
          <a class="client-download" :href="'/api/clients/' + client.file + '.zip'" :download="client.file + '.zip'" :aria-label="'下载 ' + client.name + ' ' + client.arch + ' 客户端安装包'">下载安装包（ZIP） ↓</a>
        </article>
      </div>
    </section>
    <section class="card" aria-labelledby="client-start-heading">
      <h3 id="client-start-heading">开始使用</h3>
      <ol>
        <li>下载后会得到一个 ZIP：里面是客户端和本站的 <code>instance.json</code>。解压到任意目录，再运行里面的可执行文件（不要单拿出来拷给别的电脑）。Windows 双击运行后在系统托盘查看状态；Linux / macOS 在终端为可执行文件执行 <code>chmod +x 文件名</code>，再用 <code>./文件名</code> 启动并保持进程运行。</li>
        <li>第一次启动会自动打开本站。若浏览器已登录，页面会直接发起配对；没登录就登录后回到工作台即可。这个客户端只能连接下载它时所在的站点。</li>
        <li>回到工作台即可从电脑或手机提交任务。有客户端在线时，任务会按需使用客户端的文件、终端与浏览器；同一账号的云端与各客户端浏览器共享登录态，无需手动指定主控端。</li>
      </ol>
      <p class="hint">升级前先退出旧客户端，再启动新版本（也可以直接在托盘里等自动升级）。下载的是未签名的可执行文件，Windows / macOS 可能提示安全拦截，请仅在确认本站与文件可信后按系统提示批准运行。</p>
      <p class="hint">每个站点的安装包只能用在这个站点：客户端会拒绝连接其它服务端。多个站点需要各下载一份，数据目录互不影响。远程访问建议使用 HTTPS；HTTP 会明文传输登录信息、设备凭据和命令。</p>
    </section>
    <section class="card" aria-labelledby="chrome-extension-heading">
      <h3 id="chrome-extension-heading">Chrome 扩展</h3>
      <p class="hint">在需要操作 Chrome 的电脑上安装，复用浏览器的登录态与标签页。容器内置浏览器已自动加载扩展，无需重复安装。</p>
      <a class="client-download" href="/clients/vega-chrome.zip" download="vega-chrome.zip" aria-label="下载 Chrome 扩展 ZIP">下载 Chrome 扩展（ZIP） ↓</a>
      <ol>
        <li>下载并解压 ZIP，保留解压后的文件夹。</li>
        <li>打开 <code>chrome://extensions</code>，开启“开发者模式”，点击“加载已解压的扩展程序”，选择包含 <code>manifest.json</code> 的文件夹。</li>
        <li>保持本地客户端运行，扩展会自动连接。更新扩展文件后，在扩展管理页点击“重新加载”。</li>
      </ol>
      <p class="hint">扩展可读取网页并执行浏览器操作，请仅安装来自可信站点的扩展包。</p>
    </section>
  </div>
</template>

<style scoped>
.resource-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 16px; margin: 20px 0; }
.resource-grid .card { margin: 0; }
.resource-grid h3 { margin: 0; }
.client-download { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 8px 16px; border-radius: 8px; background: var(--accent); color: white; text-decoration: none; }
.client-download:hover { opacity: .88; }
li { margin: 12px 0; line-height: 1.8; }
code { overflow-wrap: anywhere; }
</style>
