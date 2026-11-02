use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use kloud_work::{
    client::{ClientHandle, ConnectionState, Notification},
    config::ServerAddress,
    protocol::{ClientRequest, ServerMessage, ThreadEvent},
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};

async fn listener() -> (TcpListener, ServerAddress) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address =
        ServerAddress::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    (listener, address)
}

async fn accept_login(listener: &TcpListener, status: &str, body: Value, extra_headers: &str) {
    let (mut stream, _) = timeout(Duration::from_secs(8), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut received = Vec::new();
    let mut buffer = [0; 2048];
    loop {
        let count = timeout(Duration::from_secs(8), stream.read(&mut buffer))
            .await
            .unwrap()
            .unwrap();
        assert!(count > 0);
        received.extend_from_slice(&buffer[..count]);
        assert!(received.len() < 32768);
        if let Some(separator) = received.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&received[..separator]);
            assert!(header.starts_with("POST /api/auth/login HTTP/1.1"));
            let length: usize = header
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse().unwrap())
                })
                .unwrap();
            if received.len() >= separator + 4 + length {
                let credentials: Value =
                    serde_json::from_slice(&received[separator + 4..separator + 4 + length])
                        .unwrap();
                assert_eq!(
                    credentials,
                    json!({"username":"test-user","password":"test-password"})
                );
                break;
            }
        }
    }
    let body = body.to_string();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra_headers}\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.unwrap();
}

async fn login_ok(listener: &TcpListener) {
    accept_login(
        listener,
        "200 OK",
        json!({"token":"test-token","user":{"username":"test-user","role":"user"}}),
        "",
    )
    .await;
}

async fn accept_socket(listener: &TcpListener) -> WebSocketStream<TcpStream> {
    let (stream, _) = timeout(Duration::from_secs(8), listener.accept())
        .await
        .unwrap()
        .unwrap();
    accept_async(stream).await.unwrap()
}

async fn request(socket: &mut WebSocketStream<TcpStream>) -> Value {
    let frame = timeout(Duration::from_secs(8), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(text) = frame else {
        panic!("Expected JSON request");
    };
    serde_json::from_str(&text).unwrap()
}

async fn send(socket: &mut WebSocketStream<TcpStream>, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn reply(socket: &mut WebSocketStream<TcpStream>, request: &Value, data: Value) {
    send(
        socket,
        json!({"type":"reply","id":request["id"],"ok":true,"data":data}),
    )
    .await;
}

async fn initialize(socket: &mut WebSocketStream<TcpStream>) {
    let shell = request(socket).await;
    assert_eq!(shell["type"], "shell.subscribe");
    send(socket, json!({"type":"settings","data":{}})).await;
    send(
        socket,
        json!({"type":"shell","data":{"projects":[],"threads":[],"runningThreadIds":[]}}),
    )
    .await;
    reply(socket, &shell, Value::Null).await;
    let models = request(socket).await;
    assert_eq!(models["type"], "models.list");
    reply(socket, &models, json!([])).await;
}

#[tokio::test(flavor = "current_thread")]
async fn web_settings_updates_refresh_available_models() {
    let (listener, address) = listener().await;
    let server = tokio::spawn(async move {
        login_ok(&listener).await;
        let mut socket = accept_socket(&listener).await;
        initialize(&mut socket).await;
        send(&mut socket, json!({"type":"settings","data":{}})).await;
        let refresh = request(&mut socket).await;
        assert_eq!(refresh["type"], "models.list");
        reply(
            &mut socket,
            &refresh,
            json!([{"ref":{"providerId":"custom","modelId":"new-model"},"label":"新模型"}]),
        )
        .await;
        assert!(
            timeout(Duration::from_millis(700), socket.next())
                .await
                .is_err()
        );
    });
    let (client, events) = start(address);
    let event = wait_for(&events, |event| matches!(event, Notification::Response { request: ClientRequest::ModelsList, result: Ok(data) } if data.as_array().is_some_and(|models| !models.is_empty()))).await;
    assert!(
        matches!(event, Notification::Response { result: Ok(data), .. } if data[0]["label"] == "新模型")
    );
    server.await.unwrap();
    drop(client);
}

async fn wait_for(
    events: &async_channel::Receiver<Notification>,
    predicate: impl Fn(&Notification) -> bool,
) -> Notification {
    timeout(Duration::from_secs(8), async {
        loop {
            let event = events.recv().await.unwrap();
            if predicate(&event) {
                return event;
            }
        }
    })
    .await
    .expect("Expected client notification")
}

fn start(address: ServerAddress) -> (ClientHandle, async_channel::Receiver<Notification>) {
    ClientHandle::login(address, "test-user".into(), "test-password".into()).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn login_errors_are_reported_without_opening_a_socket() {
    let (listener, address) = listener().await;
    let server = tokio::spawn(async move {
        accept_login(
            &listener,
            "401 Unauthorized",
            json!({"error":"用户名或密码错误"}),
            "",
        )
        .await;
        assert!(
            timeout(Duration::from_millis(700), listener.accept())
                .await
                .is_err()
        );
    });
    let (client, events) = start(address);
    let event = wait_for(&events, |event| {
        matches!(event, Notification::AuthFailed(_))
    })
    .await;
    assert!(matches!(event, Notification::AuthFailed(message) if message == "用户名或密码错误"));
    server.await.unwrap();
    drop(client);
}

#[tokio::test(flavor = "current_thread")]
async fn login_does_not_follow_redirects_with_credentials() {
    let (listener, address) = listener().await;
    let redirect = format!("Location: {}api/auth/login\r\n", address.as_str());
    let server = tokio::spawn(async move {
        accept_login(&listener, "307 Temporary Redirect", json!({}), &redirect).await;
        assert!(
            timeout(Duration::from_millis(700), listener.accept())
                .await
                .is_err()
        );
    });
    let (client, events) = start(address);
    wait_for(&events, |event| {
        matches!(event, Notification::AuthFailed(_))
    })
    .await;
    server.await.unwrap();
    drop(client);
}

#[tokio::test(flavor = "current_thread")]
async fn reconnect_restores_subscription_and_never_replays_a_mutation() {
    let (listener, address) = listener().await;
    let server = tokio::spawn(async move {
        login_ok(&listener).await;
        let mut first = accept_socket(&listener).await;
        initialize(&mut first).await;
        let subscribe = request(&mut first).await;
        assert_eq!(subscribe["type"], "thread.subscribe");
        assert_eq!(subscribe["threadId"], "thread-1");
        send(&mut first, json!({"type":"thread.event","threadId":"thread-1","event":{"kind":"snapshot","messages":[],"activities":[],"running":false}})).await;
        reply(&mut first, &subscribe, Value::Null).await;
        let mutation = request(&mut first).await;
        assert_eq!(mutation["type"], "turn.start");
        assert_eq!(mutation["text"], "消息只发送一次");
        first.close(None).await.unwrap();
        let mut second = accept_socket(&listener).await;
        initialize(&mut second).await;
        let restored = request(&mut second).await;
        assert_eq!(restored["type"], "thread.subscribe");
        assert_eq!(restored["threadId"], "thread-1");
        send(&mut second, json!({"type":"thread.event","threadId":"thread-1","event":{"kind":"snapshot","messages":[],"activities":[],"running":true,"live":{"text":"已恢复","reasoning":"","turnId":"turn-1","startedAt":1}}})).await;
        reply(&mut second, &restored, Value::Null).await;
        assert!(
            timeout(Duration::from_millis(700), second.next())
                .await
                .is_err()
        );
    });
    let (client, events) = start(address);
    wait_for(&events, |event| {
        matches!(event, Notification::Connection(ConnectionState::Connected))
    })
    .await;
    client.select_thread(Some("thread-1".into()));
    wait_for(&events, |event| {
        matches!(
            event,
            Notification::Message(ServerMessage::ThreadEvent {
                event: ThreadEvent::Snapshot { running: false, .. },
                ..
            })
        )
    })
    .await;
    client.request(ClientRequest::TurnStart {
        thread_id: "thread-1".into(),
        text: "消息只发送一次".into(),
        attachments: Vec::new(),
    });
    wait_for(&events, |event| {
        matches!(
            event,
            Notification::Response {
                request: ClientRequest::TurnStart { .. },
                result: Err(_)
            }
        )
    })
    .await;
    wait_for(&events, |event| matches!(event, Notification::Message(ServerMessage::ThreadEvent { event: ThreadEvent::Snapshot { live: Some(live), .. }, .. }) if live.text == "已恢复")).await;
    server.await.unwrap();
    drop(client);
}

#[tokio::test(flavor = "current_thread")]
async fn invalidated_session_returns_to_login_instead_of_retrying() {
    let (listener, address) = listener().await;
    let server = tokio::spawn(async move {
        login_ok(&listener).await;
        let mut socket = accept_socket(&listener).await;
        send(
            &mut socket,
            json!({"type":"auth.error","message":"登录已失效"}),
        )
        .await;
        assert!(
            timeout(Duration::from_millis(700), listener.accept())
                .await
                .is_err()
        );
    });
    let (client, events) = start(address);
    let event = wait_for(&events, |event| {
        matches!(event, Notification::AuthFailed(_))
    })
    .await;
    assert!(matches!(event, Notification::AuthFailed(message) if message == "登录已失效"));
    server.await.unwrap();
    drop(client);
}

#[tokio::test(flavor = "current_thread")]
async fn dropping_client_closes_socket_without_stopping_cloud_turns() {
    let (listener, address) = listener().await;
    let (ready, closing) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        login_ok(&listener).await;
        let mut socket = accept_socket(&listener).await;
        initialize(&mut socket).await;
        ready.send(()).unwrap();
        let frame = timeout(Duration::from_secs(8), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(frame, Message::Close(_)));
    });
    let (client, events) = start(address);
    wait_for(&events, |event| {
        matches!(event, Notification::Connection(ConnectionState::Connected))
    })
    .await;
    closing.await.unwrap();
    drop(client);
    drop(events);
    server.await.unwrap();
}
