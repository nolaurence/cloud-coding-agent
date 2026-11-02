use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct AuthUser {
    pub username: String,
    pub role: String,
}

#[derive(Clone, Debug, Deserialize, Default)]
pub struct Workspace {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentRuntime {
    #[default]
    Codex,
    Dsh,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider_id: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ModelOption {
    #[serde(rename = "ref")]
    pub model: ModelRef,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMeta {
    pub id: String,
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub runtime: AgentRuntime,
    pub model: Option<ModelRef>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub updated_at: u64,
    pub pinned_at: Option<u64>,
    pub access: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellState {
    pub projects: Vec<Workspace>,
    pub threads: Vec<ThreadMeta>,
    pub running_thread_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub reasoning: Option<String>,
    pub turn_id: String,
    pub created_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub id: String,
    pub started_at: u64,
    pub tool_name: String,
    pub status: String,
    pub args: Option<String>,
    pub result: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub request_id: String,
    pub kind: String,
    pub command: Option<String>,
    pub reason: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionDecision {
    Accept,
    Decline,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMessage {
    pub text: String,
    pub reasoning: String,
    pub turn_id: String,
    #[serde(default)]
    pub started_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind")]
pub enum ThreadEvent {
    #[serde(rename = "snapshot", rename_all = "camelCase")]
    Snapshot {
        messages: Vec<ChatMessage>,
        activities: Vec<ToolActivity>,
        running: bool,
        live: Option<LiveMessage>,
        pending_permission: Option<PermissionRequest>,
        error: Option<String>,
    },
    #[serde(rename = "turn.start", rename_all = "camelCase")]
    TurnStart {
        turn_id: String,
        #[serde(default)]
        started_at: Option<u64>,
    },
    #[serde(rename = "turn.end")]
    TurnEnd {},
    #[serde(rename = "user.message")]
    UserMessage { message: ChatMessage },
    #[serde(rename = "assistant.message")]
    AssistantMessage { message: ChatMessage },
    #[serde(rename = "assistant.delta", rename_all = "camelCase")]
    AssistantDelta { turn_id: String, delta: String },
    #[serde(rename = "assistant.reasoning_delta", rename_all = "camelCase")]
    ReasoningDelta { turn_id: String, delta: String },
    #[serde(rename = "tool.start")]
    ToolStart { activity: ToolActivity },
    #[serde(rename = "tool.complete")]
    ToolComplete { activity: ToolActivity },
    #[serde(rename = "permission.request")]
    PermissionRequest { request: PermissionRequest },
    #[serde(rename = "permission.resolve", rename_all = "camelCase")]
    PermissionResolve { request_id: String },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "reply")]
    Reply {
        id: String,
        ok: bool,
        data: Option<Value>,
        error: Option<String>,
    },
    #[serde(rename = "auth.error")]
    AuthError { message: String },
    #[serde(rename = "auth.user")]
    AuthUser { user: AuthUser },
    #[serde(rename = "shell")]
    Shell { data: ShellState },
    #[serde(rename = "settings")]
    Settings {},
    #[serde(rename = "thread.event", rename_all = "camelCase")]
    ThreadEvent {
        thread_id: String,
        event: ThreadEvent,
    },
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnAttachment {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum ClientRequest {
    #[serde(rename = "shell.subscribe")]
    ShellSubscribe,
    #[serde(rename = "models.list")]
    ModelsList,
    #[serde(rename = "workspace.create")]
    WorkspaceCreate { name: String },
    #[serde(rename = "thread.subscribe", rename_all = "camelCase")]
    ThreadSubscribe { thread_id: String },
    #[serde(rename = "thread.unsubscribe", rename_all = "camelCase")]
    ThreadUnsubscribe { thread_id: String },
    #[serde(rename = "thread.create", rename_all = "camelCase")]
    ThreadCreate {
        project_id: String,
        runtime: AgentRuntime,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<ModelRef>,
        agent_mode: &'static str,
        permission_mode: &'static str,
    },
    #[serde(rename = "thread.setPinned", rename_all = "camelCase")]
    ThreadSetPinned { thread_id: String, pinned: bool },
    #[serde(rename = "thread.delete", rename_all = "camelCase")]
    ThreadDelete { thread_id: String },
    #[serde(rename = "turn.start", rename_all = "camelCase")]
    TurnStart {
        thread_id: String,
        text: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<TurnAttachment>,
    },
    #[serde(rename = "turn.interrupt", rename_all = "camelCase")]
    TurnInterrupt { thread_id: String },
    #[serde(rename = "permission.respond", rename_all = "camelCase")]
    PermissionRespond {
        thread_id: String,
        request_id: String,
        decision: PermissionDecision,
    },
}

impl ClientRequest {
    pub fn encode(&self, id: &str) -> serde_json::Result<String> {
        let mut value = serde_json::to_value(self)?;
        value["id"] = id.into();
        serde_json::to_string(&value)
    }
}
