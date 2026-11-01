use kloud_work::{
    protocol::*,
    state::{SessionState, ThreadState, TimelineEntry},
};
use serde_json::{Value, json};

#[test]
fn client_requests_match_typescript_contract() {
    let fixtures: Value = serde_json::from_str(include_str!("fixtures/protocol.json")).unwrap();
    let thread_id = "thread-1".to_string();
    let requests = vec![
        ClientRequest::ShellSubscribe,
        ClientRequest::ModelsList,
        ClientRequest::WorkspaceCreate {
            name: "云端项目".into(),
        },
        ClientRequest::ThreadSubscribe {
            thread_id: thread_id.clone(),
        },
        ClientRequest::ThreadUnsubscribe {
            thread_id: thread_id.clone(),
        },
        ClientRequest::ThreadCreate {
            project_id: "workspace-1".into(),
            runtime: AgentRuntime::Codex,
            model: None,
            agent_mode: "standard",
            permission_mode: "request",
        },
        ClientRequest::ThreadCreate {
            project_id: "workspace-1".into(),
            runtime: AgentRuntime::Dsh,
            model: Some(ModelRef {
                provider_id: "custom".into(),
                model_id: "model-1".into(),
                reasoning_effort: Some("high".into()),
            }),
            agent_mode: "standard",
            permission_mode: "request",
        },
        ClientRequest::TurnStart {
            thread_id: thread_id.clone(),
            text: "你好".into(),
        },
        ClientRequest::TurnInterrupt {
            thread_id: thread_id.clone(),
        },
        ClientRequest::PermissionRespond {
            thread_id: thread_id.clone(),
            request_id: "permission-1".into(),
            decision: PermissionDecision::Accept,
        },
        ClientRequest::PermissionRespond {
            thread_id,
            request_id: "permission-1".into(),
            decision: PermissionDecision::Decline,
        },
    ];
    let encoded: Vec<Value> = requests
        .into_iter()
        .map(|request| serde_json::from_str(&request.encode("contract").unwrap()).unwrap())
        .collect();
    assert_eq!(json!(encoded), fixtures["client"]);
}

#[test]
fn server_fixtures_hydrate_and_stream_without_duplicate_messages() {
    let fixtures: Value = serde_json::from_str(include_str!("fixtures/protocol.json")).unwrap();
    let mut session = SessionState::default();
    for event in fixtures["server"].as_array().unwrap() {
        let message = serde_json::from_value::<ServerMessage>(event.clone()).unwrap();
        session.apply(message);
    }
    assert_eq!(session.shell.projects[0].name, "云端项目");
    let thread = &session.threads["thread-1"];
    assert!(thread.loaded);
    assert!(!thread.running);
    assert_eq!(thread.messages.len(), 2);
    assert_eq!(thread.messages[1].text, "你好，云端");
    assert_eq!(thread.messages[1].reasoning.as_deref(), Some("思考"));
    assert_eq!(thread.activities.len(), 1);
    assert_eq!(thread.activities[0].status, "complete");
    assert!(thread.pending_permission.is_none());
    assert!(thread.live.text.is_empty());
}

fn apply(state: &mut ThreadState, value: Value) {
    state.apply(serde_json::from_value(value).unwrap());
}

#[test]
fn reconnect_snapshot_replaces_stale_state_and_restores_pending_approval() {
    let mut state = ThreadState::default();
    apply(
        &mut state,
        json!({"kind":"assistant.delta","messageId":"a","turnId":"old","delta":"旧内容"}),
    );
    apply(
        &mut state,
        json!({"kind":"snapshot","messages":[],"activities":[],"running":true,"live":{"text":"新内容","reasoning":"思考","turnId":"new","startedAt":1},"pendingPermission":{"requestId":"p","kind":"command"}}),
    );
    assert_eq!(state.live.text, "新内容");
    assert_eq!(state.pending_permission.as_ref().unwrap().request_id, "p");
    assert!(state.running && state.loaded);
    apply(
        &mut state,
        json!({"kind":"snapshot","messages":[],"activities":[],"running":false}),
    );
    assert!(state.live.text.is_empty());
    assert!(state.pending_permission.is_none());
    assert!(!state.running);
}

#[test]
fn final_messages_are_upserted_and_old_turns_do_not_clear_new_streams() {
    let mut state = ThreadState::default();
    apply(
        &mut state,
        json!({"kind":"assistant.delta","messageId":"new","turnId":"new","delta":"新回合"}),
    );
    let message = json!({"kind":"assistant.message","message":{"id":"old","role":"assistant","text":"旧回合","turnId":"old","createdAt":1}});
    apply(&mut state, message.clone());
    apply(&mut state, message);
    assert_eq!(state.messages.len(), 1);
    assert_eq!(state.live.text, "新回合");
    apply(
        &mut state,
        json!({"kind":"assistant.delta","messageId":"next","turnId":"next","delta":"下一回合"}),
    );
    assert_eq!(state.live.text, "下一回合");
}

#[test]
fn unrelated_permission_resolution_does_not_dismiss_current_prompt() {
    let mut state = ThreadState::default();
    apply(
        &mut state,
        json!({"kind":"permission.request","request":{"requestId":"current","kind":"command"}}),
    );
    apply(
        &mut state,
        json!({"kind":"permission.resolve","requestId":"old","decision":"decline"}),
    );
    assert_eq!(
        state.pending_permission.as_ref().unwrap().request_id,
        "current"
    );
}

#[test]
fn unknown_events_are_forward_compatible_but_malformed_known_events_fail() {
    assert!(matches!(
        serde_json::from_value::<ThreadEvent>(json!({"kind":"future.event","payload":{}})).unwrap(),
        ThreadEvent::Other
    ));
    assert!(serde_json::from_value::<ThreadEvent>(json!({"kind":"assistant.delta"})).is_err());
    assert!(matches!(
        serde_json::from_value::<ServerMessage>(json!({"type":"future.message"})).unwrap(),
        ServerMessage::Other
    ));
}

#[test]
fn shell_updates_sort_pinned_threads_and_discard_revoked_thread_cache() {
    let mut session = SessionState::default();
    session
        .threads
        .insert("revoked".into(), ThreadState::default());
    session.apply(
        serde_json::from_value(json!({"type":"shell","data":{"projects":[],"threads":[
        {"id":"recent","projectId":"p","title":"recent","updatedAt":100,"archived":false},
        {"id":"pinned","projectId":"p","title":"pinned","updatedAt":1,"pinnedAt":1,"archived":false}
    ],"runningThreadIds":[]}}))
        .unwrap(),
    );
    assert_eq!(session.shell.threads[0].id, "pinned");
    assert!(!session.threads.contains_key("revoked"));
}

#[test]
fn timeline_interleaves_messages_and_tools_and_keeps_live_reply_last() {
    let mut state = ThreadState::default();
    apply(
        &mut state,
        json!({"kind":"snapshot","messages":[
        {"id":"user","role":"user","text":"任务","turnId":"t","createdAt":1},
        {"id":"assistant","role":"assistant","text":"完成","turnId":"t","createdAt":3}
    ],"activities":[{"id":"tool","toolName":"exec_command","status":"complete","startedAt":2}],"running":false}),
    );
    assert_eq!(
        state.timeline(),
        vec![
            TimelineEntry::Message(0),
            TimelineEntry::Tool(0),
            TimelineEntry::Message(1)
        ]
    );
    apply(
        &mut state,
        json!({"kind":"assistant.delta","turnId":"next","delta":"接下来"}),
    );
    assert_eq!(state.timeline().last(), Some(&TimelineEntry::Live));
}
