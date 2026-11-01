use std::{collections::HashMap, time::Duration};

use anyhow::{Result, anyhow};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tokio::{
    net::TcpStream,
    sync::mpsc,
    time::{Instant, timeout},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{self, Message},
};

use crate::{config::ServerAddress, protocol::*};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Reconnecting,
}

pub enum Notification {
    Authenticated(AuthUser),
    AuthFailed(String),
    Connection(ConnectionState),
    Message(ServerMessage),
    Response {
        request: ClientRequest,
        result: std::result::Result<Value, String>,
    },
    Problem(String),
}

enum Command {
    SelectThread(Option<String>),
    Request(ClientRequest),
    Stop,
}

pub struct ClientHandle {
    commands: mpsc::UnboundedSender<Command>,
}

impl ClientHandle {
    pub fn login(
        server: ServerAddress,
        username: String,
        password: String,
    ) -> Result<(Self, async_channel::Receiver<Notification>)> {
        let (commands, receiver) = mpsc::unbounded_channel();
        let (events, notifications) = async_channel::bounded(256);
        std::thread::Builder::new()
            .name("kloud-cloud".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(_) => {
                        let _ = events
                            .send_blocking(Notification::AuthFailed("无法启动网络运行时".into()));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let mut worker = Worker {
                        server,
                        commands: receiver,
                        events,
                        desired_thread: None,
                        sequence: 0,
                    };
                    let result = tokio::select! {
                        result = authenticate(&worker.server, &username, password) => result,
                        _ = worker.commands.recv() => return,
                    };
                    match result {
                        Ok(login) => {
                            if worker.emit(Notification::Authenticated(login.user)).await {
                                worker.run(login.token).await;
                            }
                        }
                        Err(error) => {
                            worker
                                .emit(Notification::AuthFailed(error.to_string()))
                                .await;
                        }
                    }
                });
            })?;
        Ok((Self { commands }, notifications))
    }

    pub fn request(&self, request: ClientRequest) {
        let _ = self.commands.send(Command::Request(request));
    }

    pub fn select_thread(&self, thread_id: Option<String>) {
        let _ = self.commands.send(Command::SelectThread(thread_id));
    }
}

impl Drop for ClientHandle {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
    }
}

#[derive(Deserialize)]
struct LoginResponse {
    token: String,
    user: AuthUser,
}

async fn authenticate(
    server: &ServerAddress,
    username: &str,
    password: String,
) -> Result<LoginResponse> {
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?;
    let response = http
        .post(server.endpoint("/api/auth/login"))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|_| anyhow!("无法连接服务端，请检查网络和服务地址"))?;
    let status = response.status();
    if !status.is_success() {
        let error = response
            .json::<Value>()
            .await
            .ok()
            .and_then(|value| value["error"].as_str().map(str::to_owned))
            .unwrap_or_else(|| format!("登录失败 ({status})"));
        return Err(anyhow!(error));
    }
    let login = response
        .json::<LoginResponse>()
        .await
        .map_err(|_| anyhow!("登录响应格式不兼容"))?;
    if login.token.is_empty() {
        return Err(anyhow!("服务端没有返回登录凭据"));
    }
    Ok(login)
}

struct Pending {
    request: ClientRequest,
    deadline: Instant,
}

struct Worker {
    server: ServerAddress,
    commands: mpsc::UnboundedReceiver<Command>,
    events: async_channel::Sender<Notification>,
    desired_thread: Option<String>,
    sequence: u64,
}

enum SessionExit {
    Reconnect,
    Stop,
}

impl Worker {
    async fn emit(&self, event: Notification) -> bool {
        self.events.send(event).await.is_ok()
    }

    async fn offline_command(&mut self, command: Option<Command>) -> bool {
        match command {
            Some(Command::SelectThread(thread_id)) => self.desired_thread = thread_id,
            Some(Command::Request(request)) => {
                return self
                    .emit(Notification::Response {
                        request,
                        result: Err("当前未连接云端，请连接后重试".into()),
                    })
                    .await;
            }
            Some(Command::Stop) | None => return false,
        }
        true
    }

    async fn run(&mut self, token: String) {
        let mut delay = Duration::from_millis(500);
        let mut first = true;
        loop {
            if !self
                .emit(Notification::Connection(if first {
                    ConnectionState::Connecting
                } else {
                    ConnectionState::Reconnecting
                }))
                .await
            {
                return;
            }
            first = false;
            let socket_url = self.server.websocket(&token);
            let attempt = timeout(Duration::from_secs(15), connect_async(socket_url.as_str()));
            tokio::pin!(attempt);
            let result = loop {
                tokio::select! {
                    result = &mut attempt => break result,
                    command = self.commands.recv() => if !self.offline_command(command).await { return; },
                }
            };
            match result {
                Ok(Ok((mut socket, _))) => {
                    let started = Instant::now();
                    match self.connected(&mut socket).await {
                        SessionExit::Stop => {
                            let _ = socket.close(None).await;
                            return;
                        }
                        SessionExit::Reconnect => {}
                    }
                    if started.elapsed() > Duration::from_secs(10) {
                        delay = Duration::from_millis(500);
                    }
                }
                Ok(Err(tungstenite::Error::Http(response)))
                    if matches!(response.status().as_u16(), 401 | 403) =>
                {
                    self.emit(Notification::AuthFailed("登录已失效，请重新登录".into()))
                        .await;
                    return;
                }
                _ => {}
            }
            if !self
                .emit(Notification::Connection(ConnectionState::Reconnecting))
                .await
            {
                return;
            }
            let wait = tokio::time::sleep(delay);
            tokio::pin!(wait);
            loop {
                tokio::select! {
                    _ = &mut wait => break,
                    command = self.commands.recv() => if !self.offline_command(command).await { return; },
                }
            }
            delay = (delay * 2).min(Duration::from_secs(8));
        }
    }

    async fn send(
        &mut self,
        socket: &mut Socket,
        pending: &mut HashMap<String, Pending>,
        request: ClientRequest,
    ) -> bool {
        self.sequence += 1;
        let id = format!("native-{}", self.sequence);
        let encoded = match request.encode(&id) {
            Ok(encoded) => encoded,
            Err(_) => return false,
        };
        let duration = if matches!(request, ClientRequest::ThreadCreate { .. }) {
            120
        } else {
            30
        };
        pending.insert(
            id,
            Pending {
                request,
                deadline: Instant::now() + Duration::from_secs(duration),
            },
        );
        timeout(
            Duration::from_secs(10),
            socket.send(Message::Text(encoded.into())),
        )
        .await
        .is_ok_and(|result| result.is_ok())
    }

    async fn connected(&mut self, socket: &mut Socket) -> SessionExit {
        let mut pending = HashMap::new();
        let result = self.process_socket(socket, &mut pending).await;
        for (_, entry) in pending {
            if !self
                .emit(Notification::Response {
                    request: entry.request,
                    result: Err("连接已断开，请确认云端状态后重试；操作不会自动重发".into()),
                })
                .await
            {
                return SessionExit::Stop;
            }
        }
        result
    }

    async fn process_socket(
        &mut self,
        socket: &mut Socket,
        pending: &mut HashMap<String, Pending>,
    ) -> SessionExit {
        if !self
            .send(socket, pending, ClientRequest::ShellSubscribe)
            .await
            || !self.send(socket, pending, ClientRequest::ModelsList).await
        {
            return SessionExit::Reconnect;
        }
        if let Some(thread_id) = self.desired_thread.clone()
            && !self
                .send(
                    socket,
                    pending,
                    ClientRequest::ThreadSubscribe { thread_id },
                )
                .await
        {
            return SessionExit::Reconnect;
        }
        let mut clock = tokio::time::interval(Duration::from_secs(1));
        let mut last_frame = Instant::now();
        loop {
            tokio::select! {
                command = self.commands.recv() => {
                    match command {
                        Some(Command::SelectThread(next)) => {
                            if self.desired_thread != next {
                                if let Some(thread_id) = self.desired_thread.take()
                                    && !self.send(socket, pending, ClientRequest::ThreadUnsubscribe { thread_id }).await {
                                    self.desired_thread = next;
                                    return SessionExit::Reconnect;
                                }
                                self.desired_thread = next.clone();
                                if let Some(thread_id) = next
                                    && !self.send(socket, pending, ClientRequest::ThreadSubscribe { thread_id }).await {
                                    return SessionExit::Reconnect;
                                }
                            }
                        }
                        Some(Command::Request(request)) => {
                            if !self.send(socket, pending, request).await { return SessionExit::Reconnect; }
                        }
                        Some(Command::Stop) | None => return SessionExit::Stop,
                    }
                }
                frame = socket.next() => {
                    last_frame = Instant::now();
                    match frame {
                        Some(Ok(Message::Text(text))) => {
                            let message = match serde_json::from_str::<ServerMessage>(&text) {
                                Ok(message) => message,
                                Err(_) => {
                                    if !self.emit(Notification::Problem("收到无法识别的云端消息，请检查客户端版本".into())).await { return SessionExit::Stop; }
                                    continue;
                                }
                            };
                            match message {
                                ServerMessage::Settings {} => {
                                    if !pending.values().any(|entry| matches!(entry.request, ClientRequest::ModelsList))
                                        && !self.send(socket, pending, ClientRequest::ModelsList).await {
                                        return SessionExit::Reconnect;
                                    }
                                }
                                ServerMessage::AuthError { message } => {
                                    self.emit(Notification::AuthFailed(message)).await;
                                    return SessionExit::Stop;
                                }
                                ServerMessage::Reply { id, ok, data, error } => {
                                    if let Some(entry) = pending.remove(&id) {
                                        if ok && matches!(entry.request, ClientRequest::ShellSubscribe)
                                            && !self.emit(Notification::Connection(ConnectionState::Connected)).await { return SessionExit::Stop; }
                                        let result = if ok { Ok(data.unwrap_or(Value::Null)) } else { Err(error.unwrap_or_else(|| "服务端拒绝了操作".into())) };
                                        if !self.emit(Notification::Response { request: entry.request, result }).await { return SessionExit::Stop; }
                                    }
                                }
                                message => if !self.emit(Notification::Message(message)).await { return SessionExit::Stop; },
                            }
                        }
                        Some(Ok(Message::Ping(bytes))) => {
                            if !timeout(Duration::from_secs(10), socket.send(Message::Pong(bytes))).await.is_ok_and(|result| result.is_ok()) { return SessionExit::Reconnect; }
                        }
                        Some(Ok(Message::Close(Some(frame)))) if u16::from(frame.code) == 4401 => {
                            self.emit(Notification::AuthFailed("登录已失效，请重新登录".into())).await;
                            return SessionExit::Stop;
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return SessionExit::Reconnect,
                        _ => {}
                    }
                }
                _ = clock.tick() => {
                    if last_frame.elapsed() > Duration::from_secs(75) { return SessionExit::Reconnect; }
                    let expired: Vec<_> = pending.iter().filter(|(_, entry)| entry.deadline <= Instant::now()).map(|(id, _)| id.clone()).collect();
                    let mut retry_subscription = false;
                    for id in expired {
                        if let Some(entry) = pending.remove(&id) {
                            retry_subscription |= matches!(entry.request, ClientRequest::ShellSubscribe | ClientRequest::ThreadSubscribe { .. });
                            if !self.emit(Notification::Response { request: entry.request, result: Err("请求超时，请确认云端状态后重试；操作不会自动重发".into()) }).await { return SessionExit::Stop; }
                        }
                    }
                    if retry_subscription { return SessionExit::Reconnect; }
                }
            }
        }
    }
}
