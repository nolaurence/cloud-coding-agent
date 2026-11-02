use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use ely_agent::{AgentState, AgentStatus, Permission, PermissionPrompt, ToolCallCard};
use ely_chat::{
    Attachment, AttachmentButton, AttachmentChip, ChatContainer, Conversation, ConversationList,
    MessageActions, MessageAvatar, MessageBubble, MessageFooter, MessageHeader, MessageList,
    Project, ProjectList, PromptInput, Role, StepState, StreamingMarkdown, ThinkingBlock,
    new_chat_button,
};
use ely_core::{
    buttons::{Button, ButtonVariant},
    forms::{Choice, Input, InputEvent, SearchInput, Select, TextInput},
    primitives::FocusScope,
    theme::{ActiveTheme, Mode, Theme},
};
use gpui::{
    AnyElement, Context, ElementId, Entity, FocusHandle, Render, SharedString, Subscription,
    Window, div, prelude::*, px,
};
use jiff::{Timestamp, civil::Date, tz::TimeZone};

use kloud_work::{
    client::{ClientHandle, ConnectionState, Notification},
    config::{DEFAULT_SERVER, ServerAddress},
    protocol::*,
    state::{SessionState, ThreadState, TimelineEntry},
};

const APP_NAME: &str = "Kloud Work";
const ASSISTANT_NAME: &str = "Agent";

pub struct CloudApp {
    focus: FocusHandle,
    server_input: Entity<TextInput>,
    username: Entity<TextInput>,
    password: Entity<TextInput>,
    composer: Entity<TextInput>,
    workspace_name: Entity<TextInput>,
    search: Entity<TextInput>,
    today: Date,
    client: Option<ClientHandle>,
    server: Option<ServerAddress>,
    user: Option<AuthUser>,
    connecting: bool,
    connection: ConnectionState,
    generation: u64,
    state: SessionState,
    active_project: Option<String>,
    active_thread: Option<String>,
    runtime: AgentRuntime,
    model: Option<usize>,
    drafts: HashMap<String, String>,
    pending_sends: HashSet<String>,
    creating_workspace: bool,
    creating_thread: bool,
    pending_permission: Option<String>,
    /// Chips above the composer for local files picked in this session.
    attachments: Vec<Attachment>,
    /// Uploaded cloud attachments keyed by their chip, sent with the next turn.
    uploaded: Vec<(SharedString, TurnAttachment)>,
    /// Keys of chips whose upload is still running, in pick order.
    uploading_keys: Vec<SharedString>,
    attachment_seq: u64,
    confirm_delete: Option<String>,
    timeline: Vec<TimelineEntry>,
    error: Option<String>,
    dark: bool,
    _subscriptions: Vec<Subscription>,
}

impl CloudApp {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let server_input = cx.new(|cx| {
            let mut input = TextInput::new(window, cx).label("云端服务地址");
            input.set_text(
                std::env::var("CCA_SERVER_URL").unwrap_or_else(|_| DEFAULT_SERVER.into()),
                cx,
            );
            input
        });
        let username = cx.new(|cx| {
            TextInput::new(window, cx)
                .placeholder("用户名")
                .label("用户名")
        });
        let password = cx.new(|cx| {
            TextInput::new(window, cx)
                .masked()
                .placeholder("密码")
                .label("密码")
        });
        let composer = cx.new(|cx| {
            TextInput::new(window, cx)
                .multi_line(3, 9)
                .placeholder("向云端 Agent 发送消息…")
                .label("消息输入框")
        });
        let workspace_name = cx.new(|cx| {
            TextInput::new(window, cx)
                .placeholder("新工作区名称")
                .label("新工作区名称")
        });
        let search = cx.new(|cx| {
            TextInput::new(window, cx)
                .placeholder("搜索会话")
                .label("搜索会话")
        });
        let mut subscriptions = Vec::new();
        for input in [&server_input, &username, &workspace_name, &search] {
            subscriptions.push(cx.subscribe(input, |_, _, _: &InputEvent, cx| cx.notify()));
        }
        subscriptions.push(cx.subscribe(&password, |view, _, event, cx| {
            if *event == InputEvent::Submit {
                view.login(cx);
            }
            cx.notify();
        }));
        subscriptions.push(cx.subscribe(&composer, |_, _, _: &InputEvent, cx| cx.notify()));
        let today = Timestamp::now()
            .to_zoned(TimeZone::try_system().unwrap_or(TimeZone::UTC))
            .date();
        Self {
            focus: cx.focus_handle(),
            server_input,
            username,
            password,
            composer,
            workspace_name,
            search,
            today,
            client: None,
            server: None,
            user: None,
            connecting: false,
            connection: ConnectionState::Connecting,
            generation: 0,
            state: SessionState::default(),
            active_project: None,
            active_thread: None,
            runtime: AgentRuntime::Codex,
            model: None,
            drafts: HashMap::new(),
            pending_sends: HashSet::new(),
            creating_workspace: false,
            creating_thread: false,
            pending_permission: None,
            attachments: Vec::new(),
            uploaded: Vec::new(),
            uploading_keys: Vec::new(),
            attachment_seq: 0,
            confirm_delete: None,
            timeline: Vec::new(),
            error: None,
            dark: false,
            _subscriptions: subscriptions,
        }
    }

    fn online(&self) -> bool {
        self.user.is_some() && self.connection == ConnectionState::Connected
    }

    fn login(&mut self, cx: &mut Context<Self>) {
        if self.connecting || self.user.is_some() {
            return;
        }
        let server = match ServerAddress::parse(self.server_input.read(cx).text()) {
            Ok(server) => server,
            Err(error) => {
                self.error = Some(error.to_string());
                cx.notify();
                return;
            }
        };
        let username = self.username.read(cx).text().trim().to_string();
        let password = self.password.read(cx).text().to_string();
        if username.is_empty() || password.is_empty() {
            self.error = Some("请输入用户名和密码".into());
            cx.notify();
            return;
        }
        match ClientHandle::login(server.clone(), username, password) {
            Ok((client, events)) => {
                self.client = Some(client);
                self.server = Some(server);
                self.connecting = true;
                self.error = None;
                self.generation += 1;
                let generation = self.generation;
                self.password.update(cx, |input, cx| input.set_text("", cx));
                cx.spawn(async move |view, cx| {
                    while let Ok(first) = events.recv().await {
                        let mut batch = vec![first];
                        while batch.len() < 128 {
                            match events.try_recv() {
                                Ok(event) => batch.push(event),
                                Err(_) => break,
                            }
                        }
                        if !view
                            .update(cx, |view, cx| {
                                if view.generation != generation {
                                    return false;
                                }
                                for event in batch {
                                    if view.generation != generation {
                                        break;
                                    }
                                    view.handle(event, cx);
                                }
                                view.sync_list();
                                cx.notify();
                                true
                            })
                            .unwrap_or(false)
                        {
                            break;
                        }
                    }
                })
                .detach();
            }
            Err(_) => self.error = Some("无法启动云端连接".into()),
        }
        cx.notify();
    }

    fn logout(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.client = None;
        self.server = None;
        self.user = None;
        self.connecting = false;
        self.connection = ConnectionState::Connecting;
        self.state = SessionState::default();
        self.active_project = None;
        self.active_thread = None;
        self.drafts.clear();
        self.pending_sends.clear();
        self.pending_permission = None;
        self.creating_thread = false;
        self.creating_workspace = false;
        self.attachments.clear();
        self.uploaded.clear();
        self.uploading_keys.clear();
        self.confirm_delete = None;
        self.model = None;
        self.error = None;
        self.composer.update(cx, |input, cx| input.set_text("", cx));
        self.password.update(cx, |input, cx| input.set_text("", cx));
        self.workspace_name
            .update(cx, |input, cx| input.set_text("", cx));
        cx.notify();
    }

    fn handle(&mut self, event: Notification, cx: &mut Context<Self>) {
        match event {
            Notification::Authenticated(user) => {
                self.user = Some(user);
                self.connecting = false;
            }
            Notification::AuthFailed(message) => {
                self.logout(cx);
                self.error = Some(message);
            }
            Notification::Connection(connection) => self.connection = connection,
            Notification::Problem(message) => self.error = Some(message),
            Notification::Uploaded { result } => match result {
                Ok(uploaded) => {
                    let keys = std::mem::take(&mut self.uploading_keys);
                    let mut pending = uploaded.len();
                    for chip in &mut self.attachments {
                        if chip.progress.is_some() {
                            chip.progress = None;
                            pending = pending.saturating_sub(1);
                        }
                    }
                    if pending != 0 {
                        // 上传结果与本地选择不一致时,以云端返回为准清理残留的上传中标记。
                        self.attachments.retain(|chip| chip.progress.is_none());
                    }
                    self.uploaded = keys.into_iter().zip(uploaded).collect();
                }
                Err(message) => {
                    self.attachments.retain(|chip| chip.progress.is_none());
                    self.uploading_keys.clear();
                    self.uploaded.clear();
                    self.error = Some(message);
                }
            },
            Notification::Message(message) => {
                self.state.apply(message);
                if self.active_thread.as_ref().is_some_and(|id| {
                    !self
                        .state
                        .shell
                        .threads
                        .iter()
                        .any(|thread| &thread.id == id && !thread.archived)
                }) {
                    self.select_thread(None, cx);
                }
                if !self
                    .state
                    .shell
                    .projects
                    .iter()
                    .any(|project| Some(&project.id) == self.active_project.as_ref())
                {
                    self.active_project = self
                        .state
                        .shell
                        .projects
                        .first()
                        .map(|project| project.id.clone());
                }
            }
            Notification::Response { request, result } => {
                match &request {
                    ClientRequest::TurnStart {
                        thread_id, text, ..
                    } => {
                        self.pending_sends.remove(thread_id);
                        if result.is_ok() {
                            if self.active_thread.as_ref() == Some(thread_id)
                                && self.composer.read(cx).text() == *text
                            {
                                self.composer.update(cx, |input, cx| input.set_text("", cx));
                            }
                            if self.drafts.get(thread_id) == Some(text) {
                                self.drafts.remove(thread_id);
                            }
                            self.attachments.clear();
                            self.uploaded.clear();
                            self.uploading_keys.clear();
                        }
                    }
                    ClientRequest::WorkspaceCreate { .. } => self.creating_workspace = false,
                    ClientRequest::ThreadCreate { .. } => self.creating_thread = false,
                    ClientRequest::PermissionRespond { .. } => self.pending_permission = None,
                    ClientRequest::ThreadDelete { .. } => self.confirm_delete = None,
                    _ => {}
                }
                match result {
                    Err(error) => self.error = Some(error),
                    Ok(data) => match request {
                        ClientRequest::ModelsList => match serde_json::from_value(data) {
                            Ok(models) => {
                                let selected = self
                                    .model
                                    .and_then(|index| self.state.models.get(index))
                                    .map(|option| option.model.clone());
                                self.state.models = models;
                                self.model = selected.and_then(|selected| {
                                    self.state
                                        .models
                                        .iter()
                                        .position(|option| option.model == selected)
                                });
                            }
                            Err(_) => self.error = Some("模型列表格式不兼容".into()),
                        },
                        ClientRequest::ThreadCreate { .. } => {
                            match serde_json::from_value::<ThreadMeta>(data) {
                                Ok(thread) => {
                                    self.active_project = Some(thread.project_id.clone());
                                    self.select_thread(Some(thread.id), cx);
                                }
                                Err(_) => self.error = Some("新会话响应格式不兼容".into()),
                            }
                        }
                        ClientRequest::WorkspaceCreate { name } => {
                            if let Ok(workspace) = serde_json::from_value::<Workspace>(data) {
                                self.active_project = Some(workspace.id);
                                if self.workspace_name.read(cx).text().trim() == name {
                                    self.workspace_name
                                        .update(cx, |input, cx| input.set_text("", cx));
                                }
                            }
                        }
                        _ => {}
                    },
                }
            }
        }
    }

    fn select_thread(&mut self, thread_id: Option<String>, cx: &mut Context<Self>) {
        if let Some(previous) = &self.active_thread {
            self.drafts
                .insert(previous.clone(), self.composer.read(cx).text().to_string());
        }
        self.active_thread = thread_id.clone();
        self.confirm_delete = None;
        if let Some(thread) = self
            .state
            .shell
            .threads
            .iter()
            .find(|thread| Some(&thread.id) == thread_id.as_ref())
        {
            self.active_project = Some(thread.project_id.clone());
        }
        let draft = thread_id
            .as_ref()
            .and_then(|id| self.drafts.get(id))
            .cloned()
            .unwrap_or_default();
        self.composer
            .update(cx, |input, cx| input.set_text(draft, cx));
        if let Some(client) = &self.client {
            client.select_thread(thread_id);
        }
        self.sync_list();
        cx.notify();
    }

    fn can_interact(&self) -> bool {
        self.active_thread.as_ref().is_some_and(|id| {
            self.state.shell.threads.iter().any(|thread| {
                &thread.id == id && !thread.archived && thread.access.as_deref() != Some("readonly")
            })
        })
    }

    fn send_turn(&mut self, cx: &mut Context<Self>) {
        let Some(thread_id) = self.active_thread.clone() else {
            return;
        };
        let text = self.composer.read(cx).text().to_string();
        let ready = self
            .state
            .threads
            .get(&thread_id)
            .is_some_and(|thread| thread.loaded && !thread.running);
        if !self.online()
            || !self.can_interact()
            || !ready
            || text.trim().is_empty()
            || self.pending_sends.contains(&thread_id)
        {
            return;
        }
        if self.attachments.iter().any(|chip| chip.progress.is_some()) {
            self.error = Some("附件仍在云端上传中，请稍候".into());
            cx.notify();
            return;
        }
        self.pending_sends.insert(thread_id.clone());
        self.error = None;
        let attachments: Vec<TurnAttachment> = self
            .uploaded
            .iter()
            .map(|(_, attachment)| attachment.clone())
            .collect();
        if let Some(client) = &self.client {
            client.request(ClientRequest::TurnStart {
                thread_id,
                text,
                attachments,
            });
        }
        cx.notify();
    }

    fn interrupt_turn(&mut self) {
        if !self.online() || !self.can_interact() {
            return;
        }
        if let (Some(client), Some(thread_id)) = (&self.client, &self.active_thread) {
            client.request(ClientRequest::TurnInterrupt {
                thread_id: thread_id.clone(),
            });
        }
    }

    fn create_thread(&mut self, cx: &mut Context<Self>) {
        let Some(project_id) = self.active_project.clone() else {
            return;
        };
        let model = self
            .model
            .and_then(|index| self.state.models.get(index))
            .map(|option| option.model.clone());
        if !self.online() || self.creating_thread {
            return;
        }
        if self.runtime == AgentRuntime::Dsh
            && model
                .as_ref()
                .is_none_or(|model| model.provider_id == "codex")
        {
            self.error = Some("DSH 会话需要选择自定义模型；请先在网页配置模型服务".into());
            cx.notify();
            return;
        }
        self.creating_thread = true;
        if let Some(client) = &self.client {
            client.request(ClientRequest::ThreadCreate {
                project_id,
                runtime: self.runtime,
                model,
                agent_mode: "standard",
                permission_mode: "request",
            });
        }
        cx.notify();
    }

    fn set_pinned(&mut self, thread_id: String, pinned: bool) {
        if !self.online() {
            return;
        }
        if let Some(client) = &self.client {
            client.request(ClientRequest::ThreadSetPinned { thread_id, pinned });
        }
    }

    fn delete_thread(&mut self, thread_id: String, cx: &mut Context<Self>) {
        self.confirm_delete = None;
        if !self.online() {
            return;
        }
        if let Some(client) = &self.client {
            client.request(ClientRequest::ThreadDelete { thread_id });
        }
        cx.notify();
    }

    fn respond_permission(&mut self, decision: PermissionDecision, cx: &mut Context<Self>) {
        if !self.online() || !self.can_interact() || self.pending_permission.is_some() {
            return;
        }
        let Some(thread_id) = self.active_thread.clone() else {
            return;
        };
        let Some(request) = self
            .state
            .threads
            .get(&thread_id)
            .and_then(|state| state.pending_permission.clone())
        else {
            return;
        };
        self.pending_permission = Some(request.request_id.clone());
        if let Some(client) = &self.client {
            client.request(ClientRequest::PermissionRespond {
                thread_id,
                request_id: request.request_id,
                decision,
            });
        }
        cx.notify();
    }

    /// 本地交互:文件选择器选中的文件先上传到云端附件库,再随下一条消息发送。
    fn pick_attachments(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        if !self.online() {
            self.error = Some("请先连接云端后再添加附件".into());
            cx.notify();
            return;
        }
        let mut keys = Vec::with_capacity(paths.len());
        for path in &paths {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "附件".into());
            let bytes = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
            self.attachment_seq += 1;
            let key = SharedString::from(format!("attachment-{}", self.attachment_seq));
            self.attachments.push(Attachment {
                key: key.clone(),
                name: name.into(),
                bytes,
                preview: None,
                progress: Some(0.05),
            });
            keys.push(key);
        }
        self.uploading_keys.extend(keys);
        if let Some(client) = &self.client {
            client.upload_attachments(paths);
        }
        cx.notify();
    }

    fn remove_attachment(&mut self, key: &SharedString, cx: &mut Context<Self>) {
        self.attachments.retain(|chip| &chip.key != key);
        self.uploaded
            .retain(|(uploaded_key, _)| uploaded_key != key);
        cx.notify();
    }

    fn sync_list(&mut self) {
        self.timeline = self
            .active_thread
            .as_ref()
            .and_then(|id| self.state.threads.get(id))
            .map_or_else(Vec::new, |thread| thread.timeline());
    }

    fn open_web(&mut self, cx: &mut Context<Self>) {
        let server = self
            .server
            .clone()
            .or_else(|| ServerAddress::parse(self.server_input.read(cx).text()).ok());
        if server.is_none_or(|server| open::that(server.as_str()).is_err()) {
            self.error = Some("无法打开网页，请手动访问云端服务地址".into());
            cx.notify();
        }
    }

    fn toggle_theme(&mut self, cx: &mut Context<Self>) {
        self.dark = !self.dark;
        Theme::set_mode(if self.dark { Mode::Dark } else { Mode::Light }, cx);
        cx.notify();
    }

    fn active_thread_meta(&self) -> Option<&ThreadMeta> {
        self.state
            .shell
            .threads
            .iter()
            .find(|thread| Some(&thread.id) == self.active_thread.as_ref())
    }

    fn login_panel(&self, cx: &mut Context<Self>) -> AnyElement {
        let colors = cx.theme().colors.clone();
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .w(px(440.0))
                    .flex()
                    .flex_col()
                    .gap_4()
                    .p_8()
                    .rounded_xl()
                    .border_1()
                    .border_color(colors.border)
                    .bg(colors.surface)
                    .child(div().text_2xl().child(APP_NAME))
                    .child(
                        div()
                            .text_sm()
                            .text_color(colors.fg_muted)
                            .child("云端原生客户端 · 与网页共用数据"),
                    )
                    .child(Input::new(&self.server_input))
                    .child(Input::new(&self.username))
                    .child(Input::new(&self.password))
                    .child(
                        Button::new(
                            "login",
                            if self.connecting {
                                "正在登录…"
                            } else {
                                "登录云端"
                            },
                        )
                        .disabled(self.connecting)
                        .full_width()
                        .on_click(cx.listener(|view, _, _, cx| view.login(cx))),
                    )
                    .child(
                        Button::new("login-web", "在浏览器中打开 / 注册")
                            .variant(ButtonVariant::Ghost)
                            .on_click(cx.listener(|view, _, _, cx| view.open_web(cx))),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(colors.fg_muted)
                            .child("密码与登录凭据仅驻留内存，不写入磁盘。"),
                    ),
            )
            .into_any_element()
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> AnyElement {
        let colors = cx.theme().colors.clone();
        let entity = cx.entity().downgrade();
        let projects: Vec<Project> = self
            .state
            .shell
            .projects
            .iter()
            .map(|project| Project {
                key: project.id.clone().into(),
                name: project.name.clone().into(),
                count: self
                    .state
                    .shell
                    .threads
                    .iter()
                    .filter(|thread| thread.project_id == project.id && !thread.archived)
                    .count(),
            })
            .collect();
        let project_list = ProjectList::new("projects", projects).active(
            self.active_project.clone().map(SharedString::from),
            move |key, _, cx| {
                if let Some(entity) = entity.upgrade() {
                    entity.update(cx, |view, cx| {
                        view.active_project = Some(key.to_string());
                        cx.notify();
                    });
                }
            },
        );
        let entity = cx.entity().downgrade();
        let conversations: Vec<Conversation> = self
            .state
            .shell
            .threads
            .iter()
            .filter(|thread| {
                !thread.archived && Some(&thread.project_id) == self.active_project.as_ref()
            })
            .map(|thread| Conversation {
                key: thread.id.clone().into(),
                title: thread.title.clone().into(),
                at: Timestamp::from_millisecond(thread.updated_at as i64)
                    .unwrap_or(Timestamp::UNIX_EPOCH),
                pinned: thread.pinned_at.is_some(),
            })
            .collect();
        let select_entity = entity.clone();
        let pin_entity = entity.clone();
        let delete_entity = entity.clone();
        let rename_entity = entity.clone();
        let conversation_list = ConversationList::new("conversations", conversations, self.today)
            .query(self.search.read(cx).text())
            .active(
                self.active_thread.clone().map(SharedString::from),
                move |key, _, cx| {
                    if let Some(entity) = select_entity.upgrade() {
                        entity.update(cx, |view, cx| view.select_thread(Some(key.to_string()), cx));
                    }
                },
            )
            .actions(
                move |_, _, cx| {
                    if let Some(entity) = rename_entity.upgrade() {
                        entity.update(cx, |view, cx| {
                            view.error = Some("云端暂不支持在原生端重命名会话".into());
                            cx.notify();
                        });
                    }
                },
                move |key, _, cx| {
                    if let Some(entity) = pin_entity.upgrade() {
                        entity.update(cx, |view, _| {
                            let pinned = view
                                .state
                                .shell
                                .threads
                                .iter()
                                .find(|thread| &thread.id == key.as_ref())
                                .and_then(|thread| thread.pinned_at)
                                .is_some();
                            view.set_pinned(key.to_string(), !pinned);
                        });
                    }
                },
                move |key, _, cx| {
                    if let Some(entity) = delete_entity.upgrade() {
                        entity.update(cx, |view, cx| {
                            view.confirm_delete = Some(key.to_string());
                            cx.notify();
                        });
                    }
                },
            );
        let new_chat = new_chat_button("new-chat").on_click(move |_, _, cx| {
            if let Some(entity) = entity.upgrade() {
                entity.update(cx, |view, cx| view.create_thread(cx));
            }
        });
        div()
            .w(px(300.0))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .border_r_1()
            .border_color(colors.border)
            .bg(colors.surface)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_xl().child(APP_NAME))
                    .child(
                        Button::new("theme", if self.dark { "浅色" } else { "深色" })
                            .variant(ButtonVariant::Ghost)
                            .on_click(cx.listener(|view, _, _, cx| view.toggle_theme(cx))),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(colors.fg_muted)
                    .child(match self.connection {
                        ConnectionState::Connected => "● 已连接云端",
                        ConnectionState::Connecting => "○ 正在连接…",
                        ConnectionState::Reconnecting => "○ 连接中断，正在重连…",
                    }),
            )
            .child(div().flex_none().child(project_list))
            .child(div().flex_none().child(new_chat))
            .child(
                div()
                    .flex_none()
                    .child(SearchInput::new("search", &self.search)),
            )
            .child(div().flex_1().min_h_0().child(conversation_list))
            .child(div().flex_none().child(Input::new(&self.workspace_name)))
            .child(
                Button::new(
                    "create-workspace",
                    if self.creating_workspace {
                        "正在创建…"
                    } else {
                        "创建云端工作区"
                    },
                )
                .variant(ButtonVariant::Secondary)
                .full_width()
                .disabled(
                    !self.online()
                        || self.creating_workspace
                        || self.workspace_name.read(cx).text().trim().is_empty(),
                )
                .on_click(cx.listener(|view, _, _, cx| {
                    let name = view.workspace_name.read(cx).text().trim().to_string();
                    if !view.online() || view.creating_workspace || name.is_empty() {
                        return;
                    }
                    view.creating_workspace = true;
                    if let Some(client) = &view.client {
                        client.request(ClientRequest::WorkspaceCreate { name });
                    }
                    cx.notify();
                })),
            )
            .child(
                Button::new("web", "在网页管理设置与文件")
                    .variant(ButtonVariant::Ghost)
                    .full_width()
                    .on_click(cx.listener(|view, _, _, cx| view.open_web(cx))),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        self.user
                            .as_ref()
                            .map(|user| user.username.clone())
                            .unwrap_or_default(),
                    )
                    .child(
                        Button::new("logout", "退出")
                            .variant(ButtonVariant::Ghost)
                            .on_click(cx.listener(|view, _, _, cx| view.logout(cx))),
                    ),
            )
            .into_any_element()
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let colors = cx.theme().colors.clone();
        let models: Vec<_> = std::iter::once(Choice::new("default", "服务端默认模型"))
            .chain(
                self.state
                    .models
                    .iter()
                    .enumerate()
                    .filter(|(_, option)| {
                        self.runtime != AgentRuntime::Dsh || option.model.provider_id != "codex"
                    })
                    .map(|(index, option)| Choice::new(index.to_string(), option.label.clone())),
            )
            .collect();
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_3()
            .p_3()
            .border_b_1()
            .border_color(colors.border)
            .child(div().text_sm().child("新会话："))
            .child(
                Select::new(
                    "runtime",
                    [
                        Choice::new("codex", "Codex"),
                        Choice::new("dsh", "DeepSeek Harness"),
                    ],
                )
                .selected(if self.runtime == AgentRuntime::Codex {
                    "codex"
                } else {
                    "dsh"
                })
                .on_change(cx.listener(|view, value: &SharedString, _, cx| {
                    view.runtime = if value.as_ref() == "dsh" {
                        AgentRuntime::Dsh
                    } else {
                        AgentRuntime::Codex
                    };
                    view.model = None;
                    cx.notify();
                })),
            )
            .child(
                div().w(px(280.0)).child(
                    Select::new("model", models)
                        .selected(
                            self.model
                                .map_or_else(|| "default".into(), |index| index.to_string()),
                        )
                        .on_change(cx.listener(|view, value: &SharedString, _, cx| {
                            view.model = value.parse().ok();
                            cx.notify();
                        })),
                ),
            )
            .child(
                Button::new(
                    "new-thread",
                    if self.creating_thread {
                        "正在创建…"
                    } else {
                        "新建会话"
                    },
                )
                .disabled(!self.online() || self.active_project.is_none() || self.creating_thread)
                .on_click(cx.listener(|view, _, _, cx| view.create_thread(cx))),
            )
            .into_any_element()
    }

    fn message_row(&self, message: &ChatMessage) -> AnyElement {
        let id = message.id.clone();
        let meta = self.active_thread_meta();
        let model_label = meta
            .and_then(|thread| thread.model.as_ref())
            .map(|model| model.model_id.clone())
            .unwrap_or_else(|| "服务端默认".into());
        let timestamp =
            Timestamp::from_millisecond(message.created_at as i64).unwrap_or(Timestamp::UNIX_EPOCH);
        let role = if message.role == "user" {
            Role::User
        } else {
            Role::Assistant
        };
        let mut bubble = MessageBubble::new(role)
            .avatar(MessageAvatar::new(
                (ElementId::from("avatar"), id.clone()),
                role,
                if role == Role::User {
                    "你"
                } else {
                    ASSISTANT_NAME
                },
            ))
            .header(
                MessageHeader::new(
                    (ElementId::from("header"), id.clone()),
                    if role == Role::User {
                        "你"
                    } else {
                        ASSISTANT_NAME
                    },
                )
                .at(timestamp)
                .model(model_label),
            );
        if let Some(reasoning) = message.reasoning.as_ref().filter(|text| !text.is_empty()) {
            bubble = bubble.child(ThinkingBlock::new(
                (ElementId::from("reasoning"), id.clone()),
                reasoning.clone(),
                false,
                Duration::ZERO,
            ));
        }
        bubble = bubble.child(StreamingMarkdown::new(
            (ElementId::from("text"), id.clone()),
            message.text.clone(),
            false,
        ));
        if role == Role::Assistant {
            bubble = bubble.footer(MessageFooter::new().child(MessageActions::new(
                (ElementId::from("actions"), id),
                message.text.clone(),
            )));
        }
        div()
            .px_6()
            .py_3()
            .w_full()
            .min_w_0()
            .child(bubble)
            .into_any_element()
    }

    fn live_row(&self, thread: &ThreadState) -> AnyElement {
        let turn_id = thread.live.turn_id.clone();
        let elapsed = thread
            .live
            .started_at
            .map(|started| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_millis() as u64)
                    .unwrap_or(started);
                Duration::from_millis(now.saturating_sub(started))
            })
            .unwrap_or(Duration::ZERO);
        let meta = self.active_thread_meta();
        let model_label = meta
            .and_then(|thread| thread.model.as_ref())
            .map(|model| model.model_id.clone())
            .unwrap_or_else(|| "服务端默认".into());
        let mut bubble = MessageBubble::new(Role::Assistant)
            .avatar(MessageAvatar::new(
                (ElementId::from("live-avatar"), turn_id.clone()),
                Role::Assistant,
                ASSISTANT_NAME,
            ))
            .header(
                MessageHeader::new(
                    (ElementId::from("live-header"), turn_id.clone()),
                    ASSISTANT_NAME,
                )
                .model(model_label),
            );
        if !thread.live.reasoning.is_empty() {
            bubble = bubble.child(ThinkingBlock::new(
                (ElementId::from("live-reasoning"), turn_id.clone()),
                thread.live.reasoning.clone(),
                true,
                elapsed,
            ));
        }
        bubble = bubble.child(StreamingMarkdown::new(
            (ElementId::from("live-text"), turn_id.clone()),
            thread.live.text.clone(),
            true,
        ));
        div()
            .px_6()
            .py_3()
            .w_full()
            .min_w_0()
            .child(bubble)
            .into_any_element()
    }

    fn tool_row(&self, activity: &ToolActivity) -> AnyElement {
        let status = match activity.status.as_str() {
            "running" => StepState::Working,
            "complete" => StepState::Done,
            _ => StepState::Failed,
        };
        let summary = match activity.status.as_str() {
            "running" => "执行中",
            "complete" => "已完成",
            _ => "失败",
        };
        let mut card = ToolCallCard::new(
            (ElementId::from("tool"), activity.id.clone()),
            activity.tool_name.clone(),
            status,
        )
        .summary(summary);
        if let Some(args) = activity.args.as_ref().filter(|args| !args.is_empty()) {
            card = card.arguments(preview(args));
        }
        if let Some(result) = activity.result.as_ref().filter(|result| !result.is_empty()) {
            card = card.result(preview(result));
        }
        div()
            .px_6()
            .py_3()
            .w_full()
            .min_w_0()
            .child(card)
            .into_any_element()
    }

    fn chat_row(&self, index: usize) -> AnyElement {
        let Some(thread) = self
            .active_thread
            .as_ref()
            .and_then(|id| self.state.threads.get(id))
        else {
            return div().into_any_element();
        };
        match self.timeline.get(index) {
            Some(TimelineEntry::Message(message_index)) => {
                match thread.messages.get(*message_index) {
                    Some(message) => self.message_row(message),
                    None => div().into_any_element(),
                }
            }
            Some(TimelineEntry::Tool(tool_index)) => match thread.activities.get(*tool_index) {
                Some(activity) => self.tool_row(activity),
                None => div().into_any_element(),
            },
            Some(TimelineEntry::Live) => self.live_row(thread),
            None => div().into_any_element(),
        }
    }

    fn permission_bar(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(request) = self
            .active_thread
            .as_ref()
            .and_then(|id| self.state.threads.get(id))
            .and_then(|thread| thread.pending_permission.clone())
        else {
            return div().into_any_element();
        };
        let colors = cx.theme().colors.clone();
        let title = request
            .reason
            .clone()
            .unwrap_or_else(|| request.kind.clone());
        let detail = [request.command.clone(), request.cwd.clone()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
        let entity = cx.entity().downgrade();
        let prompt = PermissionPrompt::new(
            (ElementId::from("permission"), request.request_id.clone()),
            title,
            move |answer, _, cx| {
                if let Some(entity) = entity.upgrade() {
                    entity.update(cx, |view, cx| {
                        let decision = match answer {
                            Permission::Deny => PermissionDecision::Decline,
                            _ => PermissionDecision::Accept,
                        };
                        view.respond_permission(decision, cx)
                    });
                }
            },
        );
        let prompt = if detail.is_empty() {
            prompt
        } else {
            prompt.detail(detail)
        };
        div()
            .mx_5()
            .mb_3()
            .p_4()
            .rounded_lg()
            .border_1()
            .border_color(colors.border)
            .bg(colors.surface)
            .child(prompt)
            .into_any_element()
    }

    fn confirm_bar(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(thread_id) = self.confirm_delete.clone() else {
            return div().into_any_element();
        };
        let colors = cx.theme().colors.clone();
        div()
            .mx_5()
            .mb_3()
            .p_3()
            .rounded_lg()
            .border_1()
            .border_color(colors.border)
            .bg(colors.surface)
            .flex()
            .items_center()
            .gap_3()
            .child(
                div()
                    .flex_1()
                    .text_sm()
                    .child("确认删除该会话?云端历史将一并移除,且不可撤销。"),
            )
            .child(Button::new("confirm-delete", "删除").on_click(
                cx.listener(move |view, _, _, cx| view.delete_thread(thread_id.clone(), cx)),
            ))
            .child(
                Button::new("cancel-delete", "取消")
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.confirm_delete = None;
                        cx.notify();
                    })),
            )
            .into_any_element()
    }

    fn composer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity().downgrade();
        let send_entity = entity.clone();
        let stop_entity = entity.clone();
        let attach_entity = entity.clone();
        let drop_entity = entity.clone();
        let running = self
            .active_thread
            .as_ref()
            .and_then(|id| self.state.threads.get(id))
            .is_some_and(|thread| thread.running);
        let chips: Vec<_> = self
            .attachments
            .iter()
            .enumerate()
            .map(|(index, chip)| {
                let key = chip.key.clone();
                let entity = entity.clone();
                AttachmentChip::new(("attachment", index), chip.clone()).on_remove(move |_, cx| {
                    if let Some(entity) = entity.upgrade() {
                        entity.update(cx, |view, cx| view.remove_attachment(&key, cx));
                    }
                })
            })
            .collect();
        let mut input = PromptInput::new("composer", &self.composer, move |_, cx| {
            if let Some(entity) = send_entity.upgrade() {
                entity.update(cx, |view, cx| view.send_turn(cx));
            }
        })
        .tool(AttachmentButton::new("attach", move |paths, _, cx| {
            if let Some(entity) = attach_entity.upgrade() {
                entity.update(cx, |view, cx| view.pick_attachments(paths, cx));
            }
        }))
        .on_drop(move |paths, _, cx| {
            if let Some(entity) = drop_entity.upgrade() {
                entity.update(cx, |view, cx| view.pick_attachments(paths, cx));
            }
        });
        if !chips.is_empty() {
            input = input.above(div().flex().flex_wrap().gap_2().children(chips));
        }
        if running {
            input = input.busy(move |_, cx| {
                if let Some(entity) = stop_entity.upgrade() {
                    entity.update(cx, |view, cx| {
                        view.interrupt_turn();
                        cx.notify();
                    });
                }
            });
        }
        input
    }

    fn conversation(&self, cx: &mut Context<Self>) -> AnyElement {
        let colors = cx.theme().colors.clone();
        let thread = self
            .active_thread
            .as_ref()
            .and_then(|id| self.state.threads.get(id));
        let meta = self.active_thread_meta();
        let running = thread.is_some_and(|thread| thread.running);
        let loaded = thread.is_some_and(|thread| thread.loaded);
        let count = self.timeline.len();
        let entity = cx.entity().downgrade();
        let history = if self.active_thread.is_none() {
            div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_color(colors.fg_muted)
                .child("选择一个会话，或选择工作区后新建会话。")
                .into_any_element()
        } else if !loaded {
            div().p_8().child("正在读取云端会话…").into_any_element()
        } else {
            MessageList::new("messages", count, move |index, _, cx| {
                entity.upgrade().map_or_else(
                    || div().into_any_element(),
                    |entity| entity.read(cx).chat_row(index),
                )
            })
            .into_any_element()
        };
        let chat = ChatContainer::new(history).composer(self.composer(cx));
        let mut body = div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .child(self.toolbar(cx))
            .child(
                div()
                    .px_6()
                    .py_3()
                    .border_b_1()
                    .border_color(colors.border)
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        div().flex_1().child(
                            meta.map(|thread| {
                                format!(
                                    "{} · {}",
                                    thread.title,
                                    if thread.runtime == AgentRuntime::Codex {
                                        "Codex"
                                    } else {
                                        "DSH"
                                    }
                                )
                            })
                            .unwrap_or_else(|| "云端工作台".into()),
                        ),
                    )
                    .children(
                        running.then(|| AgentStatus::new("agent-status", AgentState::Working)),
                    ),
            );
        if let Some(error) = thread.and_then(|thread| thread.error.as_ref()) {
            body = body.child(
                div()
                    .px_6()
                    .py_2()
                    .text_color(colors.danger)
                    .child(error.clone()),
            );
        }
        body.child(self.permission_bar(cx))
            .child(self.confirm_bar(cx))
            .child(div().flex_1().min_h_0().child(chat))
            .into_any_element()
    }
}

impl Render for CloudApp {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let colors = theme.colors.clone();
        let root = FocusScope::new(&self.focus)
            .root()
            .size_full()
            .flex()
            .flex_col()
            .bg(colors.bg)
            .text_color(colors.fg)
            .font_family(theme.font_family.clone());
        let content = if self.user.is_some() {
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .child(self.sidebar(cx))
                .child(self.conversation(cx))
                .into_any_element()
        } else {
            self.login_panel(cx)
        };
        root.children(self.error.as_ref().map(|error| {
            div()
                .flex()
                .items_center()
                .gap_3()
                .px_4()
                .py_2()
                .border_b_1()
                .border_color(colors.border)
                .text_color(colors.danger)
                .child(div().flex_1().child(error.clone()))
                .child(
                    Button::new("dismiss-error", "关闭提示")
                        .variant(ButtonVariant::Ghost)
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.error = None;
                            cx.notify();
                        })),
                )
        }))
        .child(content)
    }
}

fn preview(text: &str) -> String {
    let mut characters = text.chars();
    let visible: String = characters.by_ref().take(1600).collect();
    if characters.next().is_some() {
        format!("{visible}\n…完整记录请在网页查看")
    } else {
        visible
    }
}
