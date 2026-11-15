# Caddy kèm plugin DNS để xin chứng chỉ wildcard *.<PLATFORM_DOMAIN> qua DNS-01.
# Mặc định Cloudflare; dùng nhà cung cấp DNS khác thì đổi module (xem caddyserver.com/docs/modules → dns.providers)
# và khối `dns` trong Caddyfile.
FROM caddy:2.8.4-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.8.4
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
