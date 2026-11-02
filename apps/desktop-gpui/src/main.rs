#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod ui;

use ely_core::{
    Assets,
    i18n::I18n,
    theme::{Mode, Theme},
};
use gpui::{App, AppContext, Bounds, WindowAppearance, WindowBounds, WindowOptions, px, size};

fn main() {
    env_logger::Builder::new()
        .parse_filters("off,gpui=warn,gpui_linux=warn,gpui_wgpu=warn,ely_core=warn")
        .init();
    gpui_platform::application()
        .with_assets(Assets)
        .run(|cx: &mut App| {
            if let Err(error) = ely_core::init(cx) {
                eprintln!("无法初始化界面：{error:#}");
                cx.quit();
                return;
            }
            ely_documents::bind_keys(cx);
            // Ely 的内置组件文案切换到中文;空 catalog 让查找回退到 Ely 的中文内置表。
            cx.set_global(I18n::new("zh-CN").catalog("zh-CN", &[]));
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            let bounds = Bounds::centered(None, size(px(1280.0), px(840.0)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(960.0), px(640.0))),
                ..Default::default()
            };
            if let Err(error) = cx.open_window(options, |window, cx| {
                window.set_window_title("Kloud Work · 云端客户端");
                Theme::set_mode(
                    if window.appearance() == WindowAppearance::Dark {
                        Mode::Dark
                    } else {
                        Mode::Light
                    },
                    cx,
                );
                cx.new(|cx| ui::CloudApp::new(window, cx))
            }) {
                eprintln!("无法打开窗口：{error:#}");
                cx.quit();
                return;
            }
            cx.activate(true);
        });
}
