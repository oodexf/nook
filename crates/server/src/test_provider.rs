#![cfg(test)]

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

#[derive(Clone)]
pub(crate) struct FakeResponse {
    pub(crate) status: u16,
    pub(crate) body: String,
    pub(crate) content_type: &'static str,
    pub(crate) delay: Duration,
    /// Optional mid-body gap: write the first `split` body bytes, sleep,
    /// then write the rest. Used to exercise idle-timeout behavior.
    pub(crate) body_gap: Option<(usize, Duration)>,
}

impl FakeResponse {
    pub(crate) fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            body: body.into(),
            content_type: "application/json",
            delay: Duration::ZERO,
            body_gap: None,
        }
    }

    pub(crate) fn sse(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            body: body.into(),
            content_type: "text/event-stream",
            delay: Duration::ZERO,
            body_gap: None,
        }
    }

    pub(crate) fn delayed(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    pub(crate) fn with_body_gap(mut self, split: usize, delay: Duration) -> Self {
        self.body_gap = Some((split, delay));
        self
    }
}

pub(crate) struct FakeProviderServer {
    base_url: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl FakeProviderServer {
    pub(crate) async fn start(responses: Vec<FakeResponse>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fake provider should bind");
        let address = listener
            .local_addr()
            .expect("fake provider address should resolve");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            for response in responses {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                loop {
                    let Ok(read) = socket.read(&mut buffer).await else {
                        return;
                    };
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if let Some(header_end) = request
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|position| position + 4)
                    {
                        let headers = String::from_utf8_lossy(&request[..header_end]);
                        let content_length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        if request.len() >= header_end + content_length {
                            break;
                        }
                    }
                }
                captured
                    .lock()
                    .expect("fake request mutex should not be poisoned")
                    .push(String::from_utf8_lossy(&request).into_owned());
                tokio::time::sleep(response.delay).await;
                let reason = match response.status {
                    200 => "OK",
                    401 => "Unauthorized",
                    403 => "Forbidden",
                    429 => "Too Many Requests",
                    500 => "Internal Server Error",
                    503 => "Service Unavailable",
                    _ => "Test Status",
                };
                let headers = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.status,
                    reason,
                    response.content_type,
                    response.body.len(),
                );
                if socket.write_all(headers.as_bytes()).await.is_err() {
                    return;
                }
                if let Some((split, gap)) = response.body_gap {
                    let split = split.min(response.body.len());
                    let (first, rest) = response.body.split_at(split);
                    if socket.write_all(first.as_bytes()).await.is_err() {
                        return;
                    }
                    tokio::time::sleep(gap).await;
                    if socket.write_all(rest.as_bytes()).await.is_err() {
                        return;
                    }
                } else if socket.write_all(response.body.as_bytes()).await.is_err() {
                    return;
                }
            }
        });
        Self {
            base_url: format!("http://{address}"),
            requests,
            task,
        }
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn requests(&self) -> Vec<String> {
        self.requests
            .lock()
            .expect("fake request mutex should not be poisoned")
            .clone()
    }
}

impl Drop for FakeProviderServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
