# MySQL for Vega (DB_TYPE=mysql). Build from the repository root:
#   docker build -t vega-mysql:local docker/mysql
# Needs MySQL 8.0.19+; MariaDB is not supported.
FROM mysql:8.4
COPY vega.cnf /etc/mysql/conf.d/vega.cnf
ENV MYSQL_DATABASE=vega \
    MYSQL_USER=vega \
    MYSQL_RANDOM_ROOT_PASSWORD=yes
HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=30 \
    CMD ["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]
