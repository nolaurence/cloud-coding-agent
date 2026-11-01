use std::collections::{HashMap, HashSet};

use ely_chat::StreamingMarkdown;
use ely_core::{
    buttons::{Button, ButtonVariant},
    forms::{Choice, Input, InputEvent, Select, TextInput},
    primitives::FocusScope,
    theme::{ActiveTheme, Mode, Theme},
};
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, ListAlignment, ListState, Render, SharedString,
    Subscription, Window, div, list, prelude::*, px,
};
use kloud_work::{
    client::{ClientHandle, ConnectionState, Notification},
    config::{DEFAULT_SERVER, ServerAddress},
    protocol::*,
    state::{SessionState, TimelineEntry},
};

pub struct CloudApp {
    focus: FocusHandle,
    server_input: Entity<TextInput>,
    username: Entity<TextInput>,
    password: Entity<TextInput>,
    composer: Entity<TextInput>,
    workspace_name: Entity<TextInput>,
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
    chat_list: ListState,
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
        let mut subscriptions = Vec::new();
        for input in [&server_input, &username, &workspace_name] {
            subscriptions.push(cx.subscribe(input, |_, _, _: &InputEvent, cx| cx.notify()));
        }
        subscriptions.push(cx.subscribe(&password, |view, _, event, cx| {
            if *event == InputEvent::Submit {
                view.login(cx);
            }
            cx.notify();
        }));
        subscriptions.push(cx.subscribe(&composer, |view, _, event, cx| {
            if *event == InputEvent::Submit {
                view.send_turn(cx);
            }
            cx.notify();
        }));
        Self {
            focus: cx.focus_handle(),
            server_input,
            username,
            password,
            composer,
            workspace_name,
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
            chat_list: ListState::new(0, ListAlignment::Bottom, px(500.0)),
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
        self.model = None;
        self.error = None;
        self.composer.update(cx, |input, cx| input.set_text("", cx));
        self.password.update(cx, |input, cx| input.set_text("", cx));
        self.workspace_name
            .update(cx, |input, cx| input.set_text("", cx));
        self.chat_list = ListState::new(0, ListAlignment::Bottom, px(500.0));
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
                    ClientRequest::TurnStart { thread_id, text } => {
                        self.pending_sends.remove(thread_id);
                        if result.is_ok() {
                            if self.active_thread.as_ref() == Some(thread_id)
                                && self.composer.read(cx).text() == text
                            {
                                self.composer.update(cx, |input, cx| input.set_text("", cx));
                            }
                            if self.drafts.get(thread_id) == Some(text) {
                                self.drafts.remove(thread_id);
                            }
                        }
                    }
                    ClientRequest::WorkspaceCreate { .. } => self.creating_workspace = false,
                    ClientRequest::ThreadCreate { .. } => self.creating_thread = false,
                    ClientRequest::PermissionRespond { .. } => self.pending_permission = None,
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
        self.chat_list = ListState::new(0, ListAlignment::Bottom, px(500.0));
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
        self.pending_sends.insert(thread_id.clone());
        self.error = None;
        if let Some(client) = &self.client {
            client.request(ClientRequest::TurnStart { thread_id, text });
        }
        cx.notify();
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

    fn sync_list(&mut self) {
        self.timeline = self
            .active_thread
            .as_ref()
            .and_then(|id| self.state.threads.get(id))
            .map_or_else(Vec::new, |thread| thread.timeline());
        let count = self.timeline.len();
        let known = self.chat_list.item_count();
        if count > known {
            self.chat_list.splice(known..known, count - known);
        } else if count < known {
            self.chat_list.splice(count..known, 0);
        }
        self.chat_list.remeasure_items(0..count);
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
                    .child(div().text_2xl().child("Kloud Work"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(colors.fg_muted)
                            .child("云端原生客户端 · 网页与桌面共用数据"),
                    )
                    .child("服务地址")
                    .child(Input::new(&self.server_input))
                    .child("用户名")
                    .child(Input::new(&self.username))
                    .child("密码")
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
        let mut projects = div()
            .id("projects")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3();
        for project in &self.state.shell.projects {
            let project_id = project.id.clone();
            let mut group = div().flex().flex_col().gap_1().child(
                Button::new(
                    SharedString::from(format!("project-{}", project.id)),
                    project.name.clone(),
                )
                .variant(if self.active_project.as_ref() == Some(&project.id) {
                    ButtonVariant::Secondary
                } else {
                    ButtonVariant::Ghost
                })
                .full_width()
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.active_project = Some(project_id.clone());
                    cx.notify();
                })),
            );
            for thread in self
                .state
                .shell
                .threads
                .iter()
                .filter(|thread| thread.project_id == project.id && !thread.archived)
            {
                let thread_id = thread.id.clone();
                let running = self.state.shell.running_thread_ids.contains(&thread.id);
                group = group.child(
                    Button::new(
                        SharedString::from(format!("thread-{}", thread.id)),
                        format!("{}{}", if running { "● " } else { "" }, thread.title),
                    )
                    .variant(if self.active_thread.as_ref() == Some(&thread.id) {
                        ButtonVariant::Secondary
                    } else {
                        ButtonVariant::Ghost
                    })
                    .full_width()
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.select_thread(Some(thread_id.clone()), cx)
                    })),
                );
            }
            projects = projects.child(group);
        }
        if self.state.shell.projects.is_empty() {
            projects = projects.child("暂无工作区，请在下方创建。");
        }
        div()
            .w(px(280.0))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .border_r_1()
            .border_color(colors.border)
            .bg(colors.surface)
            .child(div().text_xl().child("Kloud Work"))
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
            .child(projects)
            .child(Input::new(&self.workspace_name))
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
            .child(div().flex_1())
            .child(
                Button::new("theme", if self.dark { "浅色" } else { "深色" })
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.dark = !view.dark;
                        Theme::set_mode(if view.dark { Mode::Dark } else { Mode::Light }, cx);
                        cx.notify();
                    })),
            )
            .into_any_element()
    }

    fn chat_row(&self, index: usize, cx: &App) -> AnyElement {
        let colors = cx.theme().colors.clone();
        let Some(thread) = self
            .active_thread
            .as_ref()
            .and_then(|id| self.state.threads.get(id))
        else {
            return div().into_any_element();
        };
        let base = div()
            .px_8()
            .py_3()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap_2();
        let Some(entry) = self.timeline.get(index) else {
            return div().into_any_element();
        };
        if let TimelineEntry::Message(message_index) = entry {
            let message = &thread.messages[*message_index];
            return base
                .child(div().text_xs().text_color(colors.fg_muted).child(
                    match message.role.as_str() {
                        "user" => "你",
                        "assistant" => "Agent",
                        _ => "系统",
                    },
                ))
                .children(
                    message
                        .reasoning
                        .as_ref()
                        .filter(|text| !text.is_empty())
                        .map(|text| {
                            div()
                                .text_sm()
                                .text_color(colors.fg_muted)
                                .child(text.clone())
                        }),
                )
                .child(StreamingMarkdown::new(
                    SharedString::from(format!("message-{}", message.id)),
                    message.text.clone(),
                    false,
                ))
                .into_any_element();
        }
        if matches!(entry, TimelineEntry::Live) {
            return base
                .child(
                    div()
                        .text_xs()
                        .text_color(colors.fg_muted)
                        .child("Agent · 正在输出"),
                )
                .children((!thread.live.reasoning.is_empty()).then(|| {
                    div()
                        .text_sm()
                        .text_color(colors.fg_muted)
                        .child(thread.live.reasoning.clone())
                }))
                .child(StreamingMarkdown::new(
                    SharedString::from(format!("live-{}", thread.live.turn_id)),
                    thread.live.text.clone(),
                    true,
                ))
                .into_any_element();
        }
        let TimelineEntry::Tool(tool_index) = entry else {
            return div().into_any_element();
        };
        let activity = &thread.activities[*tool_index];
        base.child(div().text_sm().text_color(colors.fg_muted).child(format!(
            "工具 · {} · {}",
            activity.tool_name,
            match activity.status.as_str() {
                "running" => "执行中",
                "complete" => "已完成",
                _ => "失败",
            }
        )))
        .children(
            activity
                .args
                .as_ref()
                .map(|args| div().text_xs().child(preview(args))),
        )
        .children(activity.result.as_ref().map(|result| {
            div()
                .text_xs()
                .text_color(colors.fg_muted)
                .child(preview(result))
        }))
        .into_any_element()
    }

    fn conversation(&self, cx: &mut Context<Self>) -> AnyElement {
        let colors = cx.theme().colors.clone();
        let thread = self
            .active_thread
            .as_ref()
            .and_then(|id| self.state.threads.get(id));
        let meta = self
            .state
            .shell
            .threads
            .iter()
            .find(|thread| Some(&thread.id) == self.active_thread.as_ref());
        let running = thread.is_some_and(|thread| thread.running);
        let loaded = thread.is_some_and(|thread| thread.loaded);
        let sending = self
            .active_thread
            .as_ref()
            .is_some_and(|id| self.pending_sends.contains(id));
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
            list(self.chat_list.clone(), move |index, _, cx| {
                entity.upgrade().map_or_else(
                    || div().into_any_element(),
                    |entity| entity.read(cx).chat_row(index, cx),
                )
            })
            .size_full()
            .into_any_element()
        };
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
                    .child(
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
            .child(div().flex_1().min_h_0().child(history));
        if let Some(error) = thread.and_then(|thread| thread.error.as_ref()) {
            body = body.child(
                div()
                    .px_6()
                    .py_2()
                    .text_color(colors.danger)
                    .child(error.clone()),
            );
        }
        if let Some(permission) = thread.and_then(|thread| thread.pending_permission.as_ref()) {
            body = body.child(
                div()
                    .mx_5()
                    .p_4()
                    .rounded_lg()
                    .border_1()
                    .border_color(colors.border)
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child("Agent 请求授权")
                    .child(
                        permission
                            .reason
                            .clone()
                            .unwrap_or_else(|| permission.kind.clone()),
                    )
                    .children(permission.command.clone())
                    .children(permission.cwd.clone())
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                Button::new("accept", "允许")
                                    .disabled(
                                        !self.online()
                                            || !self.can_interact()
                                            || self.pending_permission.is_some(),
                                    )
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.respond_permission(PermissionDecision::Accept, cx)
                                    })),
                            )
                            .child(
                                Button::new("decline", "拒绝")
                                    .variant(ButtonVariant::Secondary)
                                    .disabled(
                                        !self.online()
                                            || !self.can_interact()
                                            || self.pending_permission.is_some(),
                                    )
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.respond_permission(PermissionDecision::Decline, cx)
                                    })),
                            ),
                    ),
            );
        }
        body.child(
            div()
                .p_5()
                .flex()
                .flex_col()
                .gap_2()
                .child(Input::new(&self.composer))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .child(div().flex_1().text_xs().text_color(colors.fg_muted).child(
                            if running {
                                "Agent 正在云端执行；关闭客户端不会主动停止任务。"
                            } else {
                                "Ctrl / ⌘ + Enter 发送 · 工作区和命令均在云端"
                            },
                        ))
                        .child(
                            Button::new("stop", "停止")
                                .variant(ButtonVariant::Secondary)
                                .disabled(!self.online() || !self.can_interact() || !running)
                                .on_click(cx.listener(|view, _, _, _| {
                                    if view.online()
                                        && view.can_interact()
                                        && let (Some(client), Some(thread_id)) =
                                            (&view.client, &view.active_thread)
                                    {
                                        client.request(ClientRequest::TurnInterrupt {
                                            thread_id: thread_id.clone(),
                                        });
                                    }
                                })),
                        )
                        .child(
                            Button::new("send", if sending { "正在提交…" } else { "发送" })
                                .disabled(
                                    !self.online()
                                        || !self.can_interact()
                                        || !loaded
                                        || running
                                        || sending
                                        || self.composer.read(cx).text().trim().is_empty(),
                                )
                                .on_click(cx.listener(|view, _, _, cx| view.send_turn(cx))),
                        ),
                ),
        )
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
