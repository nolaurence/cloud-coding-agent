use std::collections::HashMap;

use crate::protocol::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimelineEntry {
    Message(usize),
    Tool(usize),
    Live,
}

#[derive(Default)]
pub struct ThreadState {
    pub messages: Vec<ChatMessage>,
    pub activities: Vec<ToolActivity>,
    pub live: LiveMessage,
    pub running: bool,
    pub loaded: bool,
    pub pending_permission: Option<PermissionRequest>,
    pub error: Option<String>,
}

impl ThreadState {
    pub fn timeline(&self) -> Vec<TimelineEntry> {
        let mut entries: Vec<_> = self
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| (message.created_at, TimelineEntry::Message(index)))
            .chain(
                self.activities
                    .iter()
                    .enumerate()
                    .map(|(index, activity)| (activity.started_at, TimelineEntry::Tool(index))),
            )
            .collect();
        entries.sort_by_key(|(timestamp, _)| *timestamp);
        let mut timeline: Vec<_> = entries.into_iter().map(|(_, entry)| entry).collect();
        if !self.live.text.is_empty() || !self.live.reasoning.is_empty() {
            timeline.push(TimelineEntry::Live);
        }
        timeline
    }

    pub fn apply(&mut self, event: ThreadEvent) {
        match event {
            ThreadEvent::Snapshot {
                messages,
                activities,
                running,
                live,
                pending_permission,
                error,
            } => {
                self.messages = messages;
                self.activities = activities;
                self.running = running;
                self.live = live.unwrap_or_default();
                self.pending_permission = pending_permission;
                self.error = error;
                self.loaded = true;
            }
            ThreadEvent::TurnStart { turn_id } => {
                self.running = true;
                self.live = LiveMessage {
                    turn_id,
                    ..Default::default()
                };
                self.pending_permission = None;
                self.error = None;
            }
            ThreadEvent::TurnEnd {} => {
                self.running = false;
                self.live = LiveMessage::default();
                self.pending_permission = None;
            }
            ThreadEvent::AssistantDelta { turn_id, delta } => {
                self.prepare_live(turn_id);
                self.live.text.push_str(&delta);
            }
            ThreadEvent::ReasoningDelta { turn_id, delta } => {
                self.prepare_live(turn_id);
                self.live.reasoning.push_str(&delta);
            }
            ThreadEvent::UserMessage { message } => self.upsert(message),
            ThreadEvent::AssistantMessage { mut message } => {
                if self.live.turn_id == message.turn_id {
                    if message.reasoning.is_none() && !self.live.reasoning.is_empty() {
                        message.reasoning = Some(self.live.reasoning.clone());
                    }
                    self.live = LiveMessage::default();
                }
                self.upsert(message);
            }
            ThreadEvent::ToolStart { activity } | ThreadEvent::ToolComplete { activity } => {
                if let Some(previous) = self
                    .activities
                    .iter_mut()
                    .find(|item| item.id == activity.id)
                {
                    *previous = activity;
                } else {
                    self.activities.push(activity);
                }
            }
            ThreadEvent::PermissionRequest { request } => self.pending_permission = Some(request),
            ThreadEvent::PermissionResolve { request_id } => {
                if self
                    .pending_permission
                    .as_ref()
                    .is_some_and(|request| request.request_id == request_id)
                {
                    self.pending_permission = None;
                }
            }
            ThreadEvent::Error { message } => self.error = Some(message),
            ThreadEvent::Other => {}
        }
    }

    fn prepare_live(&mut self, turn_id: String) {
        if self.live.turn_id != turn_id {
            self.live = LiveMessage {
                turn_id,
                ..Default::default()
            };
        }
    }

    fn upsert(&mut self, message: ChatMessage) {
        if let Some(previous) = self.messages.iter_mut().find(|item| item.id == message.id) {
            *previous = message;
        } else {
            self.messages.push(message);
        }
    }
}

#[derive(Default)]
pub struct SessionState {
    pub shell: ShellState,
    pub threads: HashMap<String, ThreadState>,
    pub models: Vec<ModelOption>,
}

impl SessionState {
    pub fn apply(&mut self, message: ServerMessage) {
        match message {
            ServerMessage::Shell { mut data } => {
                data.threads.sort_by(|left, right| {
                    right
                        .pinned_at
                        .cmp(&left.pinned_at)
                        .then(right.updated_at.cmp(&left.updated_at))
                });
                self.threads
                    .retain(|id, _| data.threads.iter().any(|thread| &thread.id == id));
                self.shell = data;
            }
            ServerMessage::ThreadEvent { thread_id, event } => {
                self.threads.entry(thread_id).or_default().apply(event)
            }
            _ => {}
        }
    }
}
