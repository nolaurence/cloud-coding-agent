/** CCA account controls at the sidebar foot, next to the DSH Settings row. */
import type { SidebarFooterActionOwnerProps } from "./contract/slots";
import css from "./CcaFooterActions.module.css";

function GearIcon() {
  return (
    <svg className={css.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

function ExitIcon() {
  return (
    <svg className={css.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="m10 17 5-5-5-5" />
      <path d="M15 12H3" />
    </svg>
  );
}

/**
 * Render the CCA settings/logout shortcuts. Wide columns show labels; the
 * 56px rail keeps the icons only.
 * @param props.wide - whether the sidebar currently renders wide content.
 * @returns the footer action row.
 */
export function CcaFooterActions({ wide }: SidebarFooterActionOwnerProps) {
  return (
    <div className={`${css.actions}${wide ? ` ${css.wide}` : ""}`}>
      <a className={css.link} href="/settings/general" title="Kloud Work 设置">
        <GearIcon />
        {wide && <span>设置</span>}
      </a>
      <a className={css.link} href="/logout" title="退出登录">
        <ExitIcon />
        {wide && <span>退出</span>}
      </a>
    </div>
  );
}
