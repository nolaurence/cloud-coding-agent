window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-sidebar", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/sidebar/src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// <define:process.env>
var define_process_env_default = {};

// plugins/sidebar/src/client/index.ts
var import_dsh_client_store = require("@deepseek-ai/dsh-client-store");
var import_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");

// plugins/sidebar/src/client/CcaFooterActions.module.css
var css = ".o5IcAa_actions{justify-content:center;align-items:center;gap:2px;width:100%;padding:2px 0;display:flex}.o5IcAa_actions.o5IcAa_wide{justify-content:flex-start;gap:8px;padding:2px 6px}.o5IcAa_link{border-radius:var(--dsw-radius-sm);min-height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;align-items:center;gap:6px;padding:4px 8px;font-size:12px;line-height:1;text-decoration:none;display:inline-flex}.o5IcAa_link:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.o5IcAa_icon{flex:none;width:16px;height:16px}";
var tagId = "@deepseek-ai/dsh-client-ui-sidebar/CcaFooterActions.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-sidebar";
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}
var CcaFooterActions_default = { "actions": "o5IcAa_actions", "link": "o5IcAa_link", "wide": "o5IcAa_wide", "icon": "o5IcAa_icon" };

// plugins/sidebar/src/client/CcaFooterActions.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function GearIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { className: CcaFooterActions_default.icon, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "12", cy: "12", r: "3" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" })
  ] });
}
function ExitIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { className: CcaFooterActions_default.icon, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "m10 17 5-5-5-5" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M15 12H3" })
  ] });
}
function CcaFooterActions({ wide }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `${CcaFooterActions_default.actions}${wide ? ` ${CcaFooterActions_default.wide}` : ""}`, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", { className: CcaFooterActions_default.link, href: "/settings/general", title: "Kloud Work \u8BBE\u7F6E", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(GearIcon, {}),
      wide && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u8BBE\u7F6E" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", { className: CcaFooterActions_default.link, href: "/logout", title: "\u9000\u51FA\u767B\u5F55", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ExitIcon, {}),
      wide && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u9000\u51FA" })
    ] })
  ] });
}

// plugins/sidebar/src/client/HeaderLeadingControls.tsx
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// plugins/sidebar/src/client/HeaderLeadingControls.module.css
var css2 = ".Ku9uOa_controls{align-items:center;gap:8px;display:flex}.Ku9uOa_iconButton{border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.Ku9uOa_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}";
var tagId2 = "@deepseek-ai/dsh-client-ui-sidebar/HeaderLeadingControls.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId2) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-sidebar";
  tag.dataset.pluginCss = tagId2;
  tag.textContent = css2;
  document.head.appendChild(tag);
}
var HeaderLeadingControls_default = { "iconButton": "Ku9uOa_iconButton", "controls": "Ku9uOa_controls" };

// plugins/sidebar/src/client/HeaderLeadingControls.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
function HeaderLeadingControls({ toggleSidebar, startSession, useShortcuts, t }) {
  const shortcut = useShortcuts((rows) => rows.find((row) => row.id === "sidebar.left.toggle"));
  const newShortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.new"));
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: HeaderLeadingControls_default.controls, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: t("toggle.open"), shortcutKeys: shortcut?.keys, delayMs: 500, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: HeaderLeadingControls_default.iconButton,
        "aria-label": t("toggle.open"),
        "aria-keyshortcuts": shortcut?.aria,
        onClick: () => {
          toggleSidebar();
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconPanelLeftOutlineRegular, { size: 16 })
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Tooltip, { label: t("session.new.label"), shortcutKeys: newShortcut?.keys, delayMs: 500, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: HeaderLeadingControls_default.iconButton,
        "aria-label": t("session.new.label"),
        "aria-keyshortcuts": newShortcut?.aria,
        onClick: () => {
          startSession();
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconNewChatOutlineRegular, { size: 16 })
      }
    ) })
  ] });
}

// plugins/sidebar/src/client/SidebarRoot.tsx
var import_react = require("react");

// ../../node_modules/clsx/dist/clsx.mjs
function r(e) {
  var t, f, n = "";
  if ("string" == typeof e || "number" == typeof e) n += e;
  else if ("object" == typeof e) if (Array.isArray(e)) {
    var o = e.length;
    for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
  } else for (f in e) e[f] && (n && (n += " "), n += f);
  return n;
}
function clsx() {
  for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
  return n;
}
var clsx_default = clsx;

// plugins/sidebar/src/client/SidebarRoot.tsx
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");

// plugins/sidebar/src/client/SidebarRoot.module.css
var css3 = ".CNQDfa_root{--dsh-sidebar-inline-padding:12px;height:100%;padding:6px var(--dsh-sidebar-inline-padding);box-sizing:border-box;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);flex-direction:column;font-size:14px;display:flex}[data-platform=darwin] .CNQDfa_root{background:0 0}.CNQDfa_root.CNQDfa_collapsed{padding:18px 10px 6px}[data-windows-titlebar] .CNQDfa_root .CNQDfa_logoRow{height:40px;margin:0;padding:0}[data-windows-titlebar] .CNQDfa_toggle{top:calc((var(--dsh-windows-titlebar-height) - 28px) / 2);z-index:30;-webkit-app-region:no-drag;position:fixed;left:12px}[data-windows-titlebar] .CNQDfa_root.CNQDfa_collapsed .CNQDfa_logoRow{height:0}[data-windows-titlebar] .CNQDfa_root:not(.CNQDfa_collapsed) .CNQDfa_brand{padding-left:4px}[data-windows-titlebar] .CNQDfa_brandIdentity{transform:translateY(1px)}[data-windows-titlebar] .CNQDfa_brandMark{transform:translate(1px)}[data-windows-titlebar] .CNQDfa_brandName{font-weight:400}[data-windows-titlebar] .CNQDfa_root.CNQDfa_collapsed{padding:0}[data-windows-titlebar] .CNQDfa_root:not(.CNQDfa_collapsed) .CNQDfa_newSession{margin-top:8px;margin-left:0}[data-windows-titlebar] .CNQDfa_collapsed .CNQDfa_panelList,[data-windows-titlebar] .CNQDfa_collapsed .CNQDfa_regionArea,[data-windows-titlebar] .CNQDfa_collapsed .CNQDfa_footArea{display:none}html[data-windows-titlebar]:has([data-sidebar-collapsed=true]){--dsh-windows-menu-start:84px}[data-windows-titlebar] .CNQDfa_collapsed .CNQDfa_newSession{top:calc((var(--dsh-windows-titlebar-height) - 28px) / 2);z-index:30;-webkit-app-region:no-drag;border:none;margin:0;padding:0;position:fixed;left:48px}[data-windows-titlebar] .CNQDfa_railIn .CNQDfa_iconButton,[data-windows-titlebar] .CNQDfa_railIn .CNQDfa_newSession{animation:none}[data-windows-titlebar] .CNQDfa_collapsed .CNQDfa_toggle,[data-windows-titlebar] .CNQDfa_collapsed .CNQDfa_newSession{corner-shape:round;width:28px;height:28px;color:var(--dsw-alias-label-secondary);border-radius:50%}[data-windows-titlebar] .CNQDfa_collapsed .CNQDfa_toggle .CNQDfa_panelIcon{display:inline}.CNQDfa_root.CNQDfa_quietBars{--dsh-scrollbar-thumb:transparent;--dsh-scrollbar-thumb-hover:transparent}.CNQDfa_fading>*{opacity:0;transition:opacity .15s var(--ds-ease-in-out)}.CNQDfa_wide{animation:CNQDfa_wide-in .2s var(--ds-ease-in-out)}@keyframes CNQDfa_wide-in{0%{opacity:0}}.CNQDfa_railIn .CNQDfa_iconButton,.CNQDfa_railIn .CNQDfa_newSession,.CNQDfa_railIn .CNQDfa_panelList,.CNQDfa_railIn .CNQDfa_regionArea{animation:CNQDfa_rail-in .15s var(--ds-ease-in-out) backwards}.CNQDfa_railIn .CNQDfa_footArea{animation:CNQDfa_rail-fade-in .15s var(--ds-ease-in-out) backwards}@keyframes CNQDfa_rail-in{0%{opacity:0;transform:translate(49px)}}@keyframes CNQDfa_rail-fade-in{0%{opacity:0}}.CNQDfa_topStrip{box-sizing:border-box;height:52px;margin:-6px calc(-1 * var(--dsh-sidebar-inline-padding)) 0;flex:none;justify-content:flex-end;align-items:center;padding:0 12px 2px;display:flex}[data-fullscreen] .CNQDfa_topStrip{justify-content:flex-start}.CNQDfa_topStrip+.CNQDfa_logoRow{margin-top:-12px}.CNQDfa_logoRow{box-sizing:border-box;flex:none;justify-content:flex-end;align-items:center;gap:8px;height:60px;margin-bottom:4px;padding:8px 0 8px 4px;display:flex;overflow:hidden}.CNQDfa_collapsed .CNQDfa_logoRow{justify-content:flex-start;height:36px;margin-bottom:12px;padding:0;overflow:visible}.CNQDfa_brand{min-width:0;color:inherit;cursor:pointer;background:0 0;border:none;flex:1;align-items:center;padding:0;display:inline-flex;overflow:hidden}[data-platform=darwin] .CNQDfa_brand{cursor:default}.CNQDfa_brandIdentity{align-items:center;gap:8px;min-width:0;height:24px;display:inline-flex}.CNQDfa_brandMark{flex:none;justify-content:center;align-items:center;display:inline-flex}.CNQDfa_brandName{letter-spacing:.04em;align-items:center;gap:6px;min-width:0;height:24px;font-size:18px;font-weight:600;line-height:24px;display:inline-flex}.CNQDfa_fallbackBrandName{letter-spacing:0;white-space:nowrap;font-size:17px}.CNQDfa_localBuildBrand{white-space:nowrap;flex-direction:column;flex:none;justify-content:center;align-items:flex-start;gap:1px;height:24px;display:inline-flex}.CNQDfa_localBuildTitle{letter-spacing:0;font-size:12px;line-height:13px}.CNQDfa_iconButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex;position:relative}.CNQDfa_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.CNQDfa_iconButton.CNQDfa_toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.CNQDfa_collapsed .CNQDfa_iconButton{border-radius:var(--dsw-radius-md);width:36px;height:36px}.CNQDfa_collapsed .CNQDfa_toggle .CNQDfa_panelIcon{display:none}.CNQDfa_collapsed .CNQDfa_toggle:hover .CNQDfa_panelIcon{display:inline}.CNQDfa_collapsed .CNQDfa_toggle:hover .CNQDfa_railMark{display:none}.CNQDfa_railMark{justify-content:center;align-items:center;display:inline-flex}.CNQDfa_collapsed .CNQDfa_iconButton{color:var(--dsw-alias-label-primary)}.CNQDfa_buildVersion{height:10px;color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);white-space:nowrap;border-radius:2px;flex:none;align-items:center;padding:0 3px;font-size:6px;font-weight:500;line-height:10px;display:inline-flex}.CNQDfa_newSession{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-elevated-fill);height:38px;color:var(--dsw-alias-label-primary);cursor:pointer;flex:none;justify-content:center;align-items:center;gap:0;margin:0 2px 12px;padding:8px 12px;font-size:14px;font-weight:500;line-height:22px;display:flex;position:relative;overflow:hidden;container-type:inline-size}.CNQDfa_newSession:hover{background:var(--dsw-alias-button-floating-hover)}[data-platform=darwin] .CNQDfa_newSession{background:#ffffff8c}[data-platform=darwin] .CNQDfa_newSession:hover{background:#ffffff4d}[data-platform=darwin] [data-ds-dark-theme] .CNQDfa_newSession{background:#ffffff26}[data-platform=darwin] [data-ds-dark-theme] .CNQDfa_newSession:hover{background:#fff3}.CNQDfa_collapsed .CNQDfa_newSession{background:0 0;border-color:#0000;align-self:flex-start;gap:0;width:36px;height:36px;margin:0 0 12px;padding:0}.CNQDfa_collapsed .CNQDfa_newSession:hover{background:var(--dsw-alias-interactive-bg-hover)}.CNQDfa_newSessionLabel{white-space:nowrap;max-width:200px;overflow:hidden}.CNQDfa_collapsed .CNQDfa_newSessionLabel{max-width:0}.CNQDfa_newSessionLabelMask{flex:1;min-width:0}.CNQDfa_newSession:is(:hover,:focus-visible) .CNQDfa_newSessionLabelMask:has(+.CNQDfa_newSessionShortcut){overflow:hidden;mask-image:linear-gradient(90deg,#000 calc(100% - 16px),#0000)}.CNQDfa_newSessionContent{justify-content:center;align-items:center;gap:6px;width:100cqw;display:flex}.CNQDfa_newSessionContent>svg{flex:none}.CNQDfa_newSessionShortcut{opacity:0;pointer-events:none;flex:none;font-weight:400;display:inline-flex}.CNQDfa_newSession:is(:hover,:focus-visible) .CNQDfa_newSessionShortcut{opacity:1}.CNQDfa_panelList{flex-direction:column;flex:none;gap:4px;margin-bottom:8px;display:flex}.CNQDfa_panelRow{box-sizing:border-box;border-radius:var(--dsw-radius-md);min-height:36px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:8px;margin:0 2px;padding:7px 8px;line-height:22px;display:flex}.CNQDfa_panelRow:hover{background:var(--dsw-alias-interactive-bg-hover)}.CNQDfa_panelRow.CNQDfa_panelActive{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.CNQDfa_panelRow:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.CNQDfa_panelGlyph{flex:none;justify-content:center;align-items:center;display:inline-flex}.CNQDfa_panelTitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.CNQDfa_collapsed .CNQDfa_panelList{gap:12px;margin-bottom:12px}.CNQDfa_collapsed .CNQDfa_panelRow{width:36px;height:36px;color:var(--dsw-alias-label-primary);justify-content:center;margin:0;padding:0}.CNQDfa_regionArea{min-height:0;margin-left:-4px;margin-right:calc(-1 * var(--dsh-sidebar-inline-padding));flex-direction:column;flex:1;padding-left:4px;display:flex;overflow:hidden}.CNQDfa_collapsed .CNQDfa_regionArea{margin-left:0;margin-right:0;padding-left:0}.CNQDfa_footArea{flex-direction:column;flex:none;display:flex}.CNQDfa_settingsArea,.CNQDfa_footerActions{flex:none;width:100%;min-width:0}.CNQDfa_footerActions{display:flex}.CNQDfa_collapsed .CNQDfa_footArea{align-items:center}.CNQDfa_collapsed .CNQDfa_settingsArea,.CNQDfa_collapsed .CNQDfa_footerActions{justify-content:center;width:auto;display:flex}@media (prefers-reduced-motion:reduce){.CNQDfa_wide,.CNQDfa_fading>*,.CNQDfa_railIn .CNQDfa_iconButton,.CNQDfa_railIn .CNQDfa_newSession,.CNQDfa_railIn .CNQDfa_panelList,.CNQDfa_railIn .CNQDfa_footArea,.CNQDfa_railIn .CNQDfa_regionArea{transition:none;animation:none}}";
var tagId3 = "@deepseek-ai/dsh-client-ui-sidebar/SidebarRoot.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId3) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-sidebar";
  tag.dataset.pluginCss = tagId3;
  tag.textContent = css3;
  document.head.appendChild(tag);
}
var SidebarRoot_default = { "logoRow": "CNQDfa_logoRow", "iconButton": "CNQDfa_iconButton", "panelIcon": "CNQDfa_panelIcon", "brandMark": "CNQDfa_brandMark", "rail-in": "CNQDfa_rail-in", "buildVersion": "CNQDfa_buildVersion", "footArea": "CNQDfa_footArea", "wide-in": "CNQDfa_wide-in", "brandIdentity": "CNQDfa_brandIdentity", "brandName": "CNQDfa_brandName", "rail-fade-in": "CNQDfa_rail-fade-in", "newSessionLabelMask": "CNQDfa_newSessionLabelMask", "fading": "CNQDfa_fading", "root": "CNQDfa_root", "panelList": "CNQDfa_panelList", "quietBars": "CNQDfa_quietBars", "brand": "CNQDfa_brand", "wide": "CNQDfa_wide", "footerActions": "CNQDfa_footerActions", "newSession": "CNQDfa_newSession", "collapsed": "CNQDfa_collapsed", "panelRow": "CNQDfa_panelRow", "toggle": "CNQDfa_toggle", "panelActive": "CNQDfa_panelActive", "fallbackBrandName": "CNQDfa_fallbackBrandName", "newSessionContent": "CNQDfa_newSessionContent", "panelTitle": "CNQDfa_panelTitle", "railMark": "CNQDfa_railMark", "topStrip": "CNQDfa_topStrip", "railIn": "CNQDfa_railIn", "localBuildTitle": "CNQDfa_localBuildTitle", "panelGlyph": "CNQDfa_panelGlyph", "localBuildBrand": "CNQDfa_localBuildBrand", "regionArea": "CNQDfa_regionArea", "newSessionShortcut": "CNQDfa_newSessionShortcut", "settingsArea": "CNQDfa_settingsArea", "newSessionLabel": "CNQDfa_newSessionLabel" };

// plugins/sidebar/src/client/SidebarRoot.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
var COLLAPSE_SETTLE_MS = 150;
var SCROLLBAR_LINGER_MS = 2e3;
function localBuildVersion() {
  const version = define_process_env_default.DSH_CLIENT_VERSION;
  if (version === void 0) return void 0;
  const commit = define_process_env_default.DSH_CLIENT_COMMIT_HASH;
  return version + (commit === void 0 ? "" : `-${commit}`) + (define_process_env_default.DSH_CLIENT_GIT_DIRTY === "true" ? "-dirty" : "");
}
function PanelRow({ id, label, wide, usePanelInfo, selectPanel, renderSlot }) {
  const active = usePanelInfo((info) => info.activePanelId === id);
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.Tooltip, { label, delayMs: 500, disabled: wide, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
    "button",
    {
      type: "button",
      className: clsx_default(SidebarRoot_default.panelRow, active && SidebarRoot_default.panelActive),
      "aria-label": label,
      "aria-current": active ? "page" : void 0,
      onClick: () => {
        selectPanel(id);
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: SidebarRoot_default.panelGlyph, "aria-hidden": "true", children: renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id }) }),
        wide && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: clsx_default(SidebarRoot_default.panelTitle, SidebarRoot_default.wide), children: label })
      ]
    }
  ) });
}
function SidebarRoot({
  collapsed,
  width,
  startSession,
  toggleSidebar,
  selectPanel,
  usePanels,
  useShortcuts,
  usePanelInfo,
  t,
  renderSlot
}) {
  const panels = usePanels((snapshot) => snapshot);
  const shortcut = useShortcuts((rows) => rows.find((row) => row.id === "sidebar.left.toggle"));
  const newShortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.new"));
  const toggleLabel = collapsed ? t("toggle.open") : t("toggle.collapse");
  const [settled, setSettled] = (0, import_react.useState)(collapsed);
  (0, import_react.useEffect)(() => {
    if (!collapsed) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSettled(true);
    }, COLLAPSE_SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [collapsed]);
  const windowsTitlebar = document.documentElement.hasAttribute("data-windows-titlebar");
  const wide = windowsTitlebar ? !collapsed : !collapsed || !settled;
  const captionTooltipSide = windowsTitlebar ? "bottom" : "right";
  const lastWideWidth = (0, import_react.useRef)(width);
  if (!collapsed) lastWideWidth.current = width;
  const everWide = (0, import_react.useRef)(!collapsed);
  if (!collapsed) everWide.current = true;
  const column = (0, import_react.useRef)(null);
  const [pointerInside, setPointerInside] = (0, import_react.useState)(false);
  const lingerTimer = (0, import_react.useRef)(void 0);
  const armLinger = () => {
    if (lingerTimer.current !== void 0) return;
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = void 0;
      setPointerInside(false);
    }, SCROLLBAR_LINGER_MS);
  };
  const cancelLinger = () => {
    window.clearTimeout(lingerTimer.current);
    lingerTimer.current = void 0;
  };
  (0, import_react.useEffect)(() => {
    if (!pointerInside) return;
    const onMove = (event) => {
      const rect = column.current?.getBoundingClientRect();
      if (rect === void 0) return;
      const inside = event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom;
      if (inside) cancelLinger();
      else armLinger();
    };
    document.addEventListener("pointermove", onMove);
    return () => {
      document.removeEventListener("pointermove", onMove);
      cancelLinger();
    };
  }, [pointerInside]);
  const buildVersion = localBuildVersion();
  const darwinDesktop = (0, import_dsh_client_ui_primitives2.isDarwinDesktop)();
  const toggle = /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.Tooltip, { label: toggleLabel, shortcutKeys: shortcut?.keys, delayMs: 500, side: captionTooltipSide, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
    "button",
    {
      type: "button",
      className: clsx_default(SidebarRoot_default.iconButton, SidebarRoot_default.toggle),
      "aria-label": toggleLabel,
      "aria-keyshortcuts": shortcut?.aria,
      onClick: () => {
        toggleSidebar();
      },
      children: [
        !wide && !windowsTitlebar && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: SidebarRoot_default.railMark, "aria-hidden": "true", children: renderSlot("sidebar.brand.mark", { size: 24 }, { fallback: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.FishLogo, { size: 24 }) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.IconPanelLeftOutlineRegular, { className: SidebarRoot_default.panelIcon, size: wide || windowsTitlebar ? 16 : 18 }),
        !wide && renderSlot("sidebar.toggle.badge", {})
      ]
    }
  ) });
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
    "div",
    {
      ref: column,
      className: clsx_default(
        SidebarRoot_default.root,
        !wide && SidebarRoot_default.collapsed,
        !wide && everWide.current && SidebarRoot_default.railIn,
        collapsed && wide && SidebarRoot_default.fading,
        !pointerInside && SidebarRoot_default.quietBars
      ),
      style: wide ? { width: collapsed ? lastWideWidth.current : width } : void 0,
      onPointerEnter: () => {
        cancelLinger();
        setPointerInside(true);
      },
      onPointerLeave: () => {
        armLinger();
      },
      children: [
        darwinDesktop && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: SidebarRoot_default.topStrip, "data-window-drag": true, children: toggle }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: SidebarRoot_default.logoRow, "data-window-drag": true, children: [
          wide && (() => {
            const identity = /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: SidebarRoot_default.brandIdentity, "aria-hidden": "true", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: SidebarRoot_default.brandMark, children: renderSlot("sidebar.brand.mark", { size: 24 }, { fallback: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.FishLogo, { size: 24 }) }) }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: SidebarRoot_default.brandName, children: renderSlot("sidebar.brand.name", {}, {
                fallback: buildVersion === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: SidebarRoot_default.fallbackBrandName, children: t("brand.localBuild") }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: SidebarRoot_default.localBuildBrand, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: SidebarRoot_default.localBuildTitle, children: t("brand.localBuild") }),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: SidebarRoot_default.buildVersion, children: buildVersion })
                ] })
              }) })
            ] });
            return darwinDesktop ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: clsx_default(SidebarRoot_default.brand, SidebarRoot_default.wide), children: identity }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.Tooltip, { label: t("session.new.label"), shortcutKeys: newShortcut?.keys, delayMs: 500, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "button",
              {
                type: "button",
                className: clsx_default(SidebarRoot_default.brand, SidebarRoot_default.wide),
                "aria-label": t("session.new.label"),
                "aria-keyshortcuts": newShortcut?.aria,
                onClick: () => {
                  startSession();
                },
                children: identity
              }
            ) });
          })(),
          !darwinDesktop && toggle
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.Tooltip, { label: t("session.new.label"), shortcutKeys: newShortcut?.keys, delayMs: 500, side: captionTooltipSide, disabled: wide, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
          "button",
          {
            type: "button",
            className: SidebarRoot_default.newSession,
            "aria-label": t("session.new.label"),
            "aria-keyshortcuts": newShortcut?.aria,
            onClick: () => {
              startSession();
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: SidebarRoot_default.newSessionLabelMask, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: SidebarRoot_default.newSessionContent, children: [
                wide ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.IconNewChatOutlineMedium, { size: 14 }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.IconNewChatOutlineRegular, { size: windowsTitlebar ? 16 : 18 }),
                wide && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: clsx_default(SidebarRoot_default.newSessionLabel, SidebarRoot_default.wide), children: t("session.new") })
              ] }) }),
              wide && newShortcut !== void 0 && newShortcut.keys.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: SidebarRoot_default.newSessionShortcut, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.ShortcutKeys, { keys: newShortcut.keys }) })
            ]
          }
        ) }),
        panels.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("nav", { className: SidebarRoot_default.panelList, "aria-label": t("panels.label"), children: panels.map(({ id, label }) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          PanelRow,
          {
            id,
            label,
            wide,
            usePanelInfo,
            selectPanel,
            renderSlot
          },
          id
        )) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: SidebarRoot_default.regionArea, children: renderSlot("sidebar.workspaces", {
          wide,
          expandSidebar: () => {
            if (collapsed) toggleSidebar();
          }
        }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: SidebarRoot_default.footArea, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: SidebarRoot_default.footerActions, children: renderSlot("sidebar.footer.action", { wide }) }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: SidebarRoot_default.settingsArea, children: renderSlot("sidebar.settings", { wide }) })
        ] })
      ]
    }
  );
}

// plugins/sidebar/src/client/locales.ts
var zh = {
  "session.new": "\u65B0\u4F1A\u8BDD",
  "session.new.label": "\u65B0\u5EFA\u4F1A\u8BDD",
  "toggle.open": "\u6253\u5F00\u4FA7\u8FB9\u680F",
  "toggle.collapse": "\u6536\u8D77\u4FA7\u8FB9\u680F",
  "panels.label": "\u5168\u5C40\u9762\u677F"
};
var en = {
  "session.new": "New Session",
  "session.new.label": "New session",
  "toggle.open": "Open sidebar",
  "toggle.collapse": "Collapse sidebar",
  "panels.label": "Global panels"
};

// plugins/sidebar/src/client/index.ts
var NS = "sidebar";
var inject = ["slots", "layout", "uiWorkspace", "locale", "shortcuts"];
function apply(ctx) {
  const workspaceNavigation = ctx.get("uiWorkspace");
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-sidebar: dictionaries");
  const panels = (0, import_dsh_client_store.createSnapshotStore)([]);
  const syncPanels = () => {
    const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => {
      const id = options.id;
      return { id, order: options.order ?? 0, label: (0, import_dsh_client_ui_slots.resolveSlotLabel)(options.label) ?? id };
    }).sort((a, b) => a.order - b.order);
    const previous = panels.getSnapshot();
    if (previous.length === next.length && previous.every((panel, index) => {
      const candidate = next[index];
      return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label;
    })) return;
    panels.set(next);
  };
  ctx.effect(() => ctx.slots.subscribe("sidebar.panellist", syncPanels), "ui-sidebar: panel entries");
  ctx.effect(() => ctx.locale.subscribe(syncPanels), "ui-sidebar: panel labels");
  const injectProps = () => ({
    // The shell's New Session button rides the Workspace UI's shared action
    // (current Session Workspace, then recent Workspace).
    startSession: (workspaceId) => {
      workspaceNavigation.startSession(workspaceId);
    },
    toggleSidebar: () => {
      ctx.layout.toggleSidebar();
    },
    selectPanel: (id) => {
      ctx.layout.selectPanel(id);
    },
    hooks: { panels, shortcuts: ctx.shortcuts.catalog }
  });
  ctx.slots.inject("sidebar", () => ctx.slots.register({
    name: "sidebar",
    locale: NS,
    children: {
      "sidebar.brand.mark": { kind: "single", scope: "root" },
      "sidebar.brand.name": { kind: "single", scope: "root" },
      "sidebar.toggle.badge": { kind: "single", scope: "root" },
      "sidebar.panellist": { kind: "list", scope: "root" },
      "sidebar.workspaces": { kind: "single", scope: "root" },
      "sidebar.settings": { kind: "single", scope: "root" },
      "sidebar.footer.action": { kind: "list", scope: "root" }
    },
    inject: injectProps
  }, SidebarRoot));
  ctx.slots.inject("shell.leading", () => ctx.slots.register({
    name: "shell.leading",
    locale: NS,
    inject: injectProps
  }, HeaderLeadingControls));
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "cca-account",
    order: 100
  }, CcaFooterActions));
  syncPanels();
}
return module.exports;
} });
//# sourceMappingURL=client.js.map
