use anyhow::{Result, bail};
use url::Url;

pub const DEFAULT_SERVER: &str = "https://agent.proxy.nolaurence.cn";

#[derive(Clone)]
pub struct ServerAddress(Url);

impl ServerAddress {
    pub fn parse(value: &str) -> Result<Self> {
        let url =
            Url::parse(value.trim()).map_err(|_| anyhow::anyhow!("请输入完整的 HTTPS 服务地址"))?;
        let loopback = url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
        if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
            bail!("云端服务必须使用 HTTPS；仅本机开发允许 HTTP");
        }
        if url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            bail!("服务地址只能包含协议、主机和端口，不能包含路径或凭据");
        }
        Ok(Self(url))
    }

    pub fn endpoint(&self, path: &str) -> Url {
        let mut url = self.0.clone();
        url.set_path(path);
        url
    }

    pub fn websocket(&self, token: &str) -> Url {
        let mut url = self.endpoint("/ws");
        let scheme = if self.0.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        let _ = url.set_scheme(scheme);
        url.query_pairs_mut().append_pair("token", token);
        url
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_cloud_and_loopback_only() {
        for valid in [
            DEFAULT_SERVER,
            "http://localhost:8787",
            "http://127.0.0.1:8787",
            "http://[::1]:8787",
        ] {
            assert!(ServerAddress::parse(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "http://example.com",
            "file:///tmp/test",
            "https://user:secret@example.com",
            "https://example.com/path",
            "https://example.com?token=secret",
            "https://example.com/#secret",
        ] {
            assert!(ServerAddress::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn websocket_encodes_credentials_without_changing_origin() {
        let server = ServerAddress::parse(DEFAULT_SERVER).unwrap();
        let socket = server.websocket("token&other=值+#");
        assert_eq!(socket.scheme(), "wss");
        assert_eq!(socket.path(), "/ws");
        assert_eq!(
            socket.query_pairs().collect::<Vec<_>>(),
            [("token".into(), "token&other=值+#".into())]
        );
    }
}
