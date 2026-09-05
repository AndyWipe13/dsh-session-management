/**
 * Client half for @dsh-external/dsh-session-management.
 *
 * Registers the "会话管理" settings section (tabs: 会话 / 导入 / 清理与统计)
 * as a thin adapter over the host SessionManagement HTTP API.  All read/business
 * logic lives in the host service; this file only renders results and calls
 * `/@dsh-external/dsh-session-management/api`.
 *
 * Design notes:
 * - Styles are injected once as a single <style> tag; every class is prefixed
 *   `dshsm-` so nothing leaks into (or from) the host page.
 * - Brand icons (Claude / OpenAI / DeepSeek, from assets/logo) ship as an
 *   inline SVG symbol sprite; symbol viewBoxes are normalized so all three
 *   marks render at the same visual weight.
 * - Confirm dialogs, the preview drawer, and toasts mount imperatively under
 *   document.body (the module loader exposes no react-dom, and body-level
 *   fixed positioning is immune to host container transforms).
 * - The service requires the exact confirm token `DELETE` for destructive
 *   calls; the UI confirms intent with a modal and then sends the token
 *   automatically, so users never type it.
 *
 * This bundle is loaded through DSH's client ModuleLoader, so it is written
 * as a factory script (CJS-style) rather than an ESM module.
 */
/* global window, document */
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-session-management',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const API = '/@dsh-external/dsh-session-management/api'

    /* ================= networking ================= */

    function readJson(res) {
      if (!res.ok) {
        return res.json().then((body) => {
          throw new Error((body && body.error) || `HTTP ${res.status}`)
        })
      }
      return res.json()
    }

    function fetchJson(url) {
      return fetch(url).then(readJson)
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(readJson)
    }

    /* ================= formatting ================= */

    const KB = 1024
    const MB = KB * 1024
    const GB = MB * 1024

    function formatBytes(bytes) {
      if (!bytes) return '0 B'
      if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`
      if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`
      return `${Math.max(1, Math.round(bytes / KB))} KB`
    }

    function formatDuration(ms) {
      if (ms == null) return '—'
      if (ms < 1000) return `${ms}ms`
      if (ms < 60e3) return `${(ms / 1000).toFixed(1)}s`
      const minutes = ms / 60e3
      if (minutes < 60) return `${minutes.toFixed(1)}m`
      return `${(minutes / 60).toFixed(1)}h`
    }

    function pad2(n) { return String(n).padStart(2, '0') }

    function absTime(value) {
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return '—'
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    }

    function relTime(value) {
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return '—'
      const diff = (Date.now() - d.getTime()) / 1000
      if (diff < 60) return '刚刚'
      if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
      if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
      if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} 天前`
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
    }

    function esc(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    }

    const sourceLabels = { dsh: 'DSH', 'claude-code': 'Claude Code', codex: 'Codex' }

    /* ================= styles & sprite ================= */

    const STYLE = `
.dshsm, .dshsm-overlay-root{
  --dshsm-surface:#FFFFFF;
  --dshsm-surface-2:#F2F4F7;
  --dshsm-border:#E4E7EC;
  --dshsm-border-strong:#CBD1DA;
  --dshsm-text:#1B2027;
  --dshsm-text-2:#59626F;
  --dshsm-text-3:#8A93A0;
  --dshsm-accent:#2F54C8;
  --dshsm-accent-weak:#E9EDFB;
  --dshsm-accent-solid:#2F54C8;
  --dshsm-accent-solid-hover:#2849AF;
  --dshsm-accent-on:#FFFFFF;
  --dshsm-danger:#C03B3B;
  --dshsm-danger-weak:#FBEDED;
  --dshsm-danger-border:#EFC2C2;
  --dshsm-ok:#22784B;
  --dshsm-ok-weak:#E5F4EC;
  --dshsm-mono-bg:#F6F7F9;
  --dshsm-scrim:rgba(23,26,32,.36);
  --dshsm-shadow:0 1px 2px rgba(20,24,32,.05),0 12px 32px -12px rgba(20,24,32,.12);
  --dshsm-src-dsh:#4D6BFE;
  --dshsm-src-claude:#D97757;
  --dshsm-src-openai:#23272E;
  --dshsm-ui:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif;
  --dshsm-mono:ui-monospace,"Cascadia Mono",Consolas,"Courier New",monospace;
}
.dshsm, .dshsm-overlay-root, .dshsm *, .dshsm-overlay-root *{box-sizing:border-box;margin:0;padding:0}
.dshsm{color:var(--dshsm-text);font-family:var(--dshsm-ui);font-size:13px;line-height:1.55;text-align:left}
.dshsm-overlay-root{font-family:var(--dshsm-ui);font-size:13px;line-height:1.55}
.dshsm button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}
.dshsm input,.dshsm select{font:inherit;color:inherit}
.dshsm svg,.dshsm-overlay-root svg{display:block}
.dshsm ::placeholder,.dshsm-overlay-root ::placeholder{color:var(--dshsm-text-3);opacity:1}
.dshsm :focus-visible,.dshsm-overlay-root :focus-visible{outline:2px solid var(--dshsm-accent);outline-offset:2px;border-radius:6px}
.dshsm-mono{font-family:var(--dshsm-mono);font-variant-numeric:tabular-nums}

/* ---------- header & tabs ---------- */
.dshsm-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:2px}
.dshsm-head h2{font-size:17px;font-weight:700;letter-spacing:-.01em;color:var(--dshsm-text)}
.dshsm-head p{font-size:12px;color:var(--dshsm-text-3)}
.dshsm-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dshsm-border);margin:10px 0 14px}
.dshsm-tab{position:relative;padding:8px 12px 10px;font-size:13px;font-weight:500;color:var(--dshsm-text-2);border-radius:8px 8px 0 0;transition:color .15s,background .15s}
.dshsm-tab:hover{color:var(--dshsm-text);background:var(--dshsm-surface-2)}
.dshsm-tab[aria-selected="true"]{color:var(--dshsm-text);font-weight:600}
.dshsm-tab[aria-selected="true"]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--dshsm-accent);border-radius:2px 2px 0 0}
.dshsm-tab .dshsm-count{display:inline-block;margin-left:6px;padding:0 6px;border-radius:99px;background:var(--dshsm-surface-2);border:1px solid var(--dshsm-border);font-family:var(--dshsm-mono);font-size:10.5px;line-height:16px;color:var(--dshsm-text-2);vertical-align:1px}
.dshsm-tab[aria-selected="true"] .dshsm-count{background:var(--dshsm-accent-weak);border-color:transparent;color:var(--dshsm-accent)}

/* ---------- toolbar controls ---------- */
.dshsm-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.dshsm-field{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 10px;background:var(--dshsm-surface);border:1px solid var(--dshsm-border);border-radius:8px;transition:border-color .15s,box-shadow .15s;color:var(--dshsm-text-3)}
.dshsm-field:focus-within{border-color:var(--dshsm-accent);box-shadow:0 0 0 3px var(--dshsm-accent-weak)}
.dshsm-field svg{flex:none}
.dshsm-field input{border:none;background:none;outline:none;font-size:13px;color:var(--dshsm-text);width:170px}
.dshsm-field input:focus-visible{outline:none}
.dshsm-field.dshsm-grow{flex:1;min-width:200px}
.dshsm-field.dshsm-grow input{width:100%}
.dshsm-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;font-size:13px;font-weight:500;border:1px solid transparent;white-space:nowrap;transition:background .15s,border-color .15s,color .15s,opacity .15s}
.dshsm-btn:disabled{opacity:.45;cursor:not-allowed}
.dshsm-btn svg{flex:none}
.dshsm-btn.dshsm-ghost{border-color:var(--dshsm-border);background:var(--dshsm-surface);color:var(--dshsm-text)}
.dshsm-btn.dshsm-ghost:hover:not(:disabled){background:var(--dshsm-surface-2)}
.dshsm-btn.dshsm-primary{background:var(--dshsm-accent-solid);color:var(--dshsm-accent-on)}
.dshsm-btn.dshsm-primary:hover:not(:disabled){background:var(--dshsm-accent-solid-hover)}
.dshsm-btn.dshsm-danger{background:var(--dshsm-danger);color:#fff}
.dshsm-btn.dshsm-danger:hover:not(:disabled){filter:brightness(1.07)}
.dshsm-spin{animation:dshsm-spin 1s linear infinite}
@keyframes dshsm-spin{to{transform:rotate(360deg)}}

/* ---------- pills & chips ---------- */
.dshsm-src-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--dshsm-text-2)}
.dshsm-src-chip .dshsm-src-dot{width:18px;height:18px;border-radius:6px;background:var(--dshsm-surface-2);display:grid;place-items:center;flex:none}
.dshsm-src-chip svg{width:12px;height:12px}
.dshsm-src-dsh{color:var(--dshsm-src-dsh)}
.dshsm-src-claude-code{color:var(--dshsm-src-claude)}
.dshsm-src-codex{color:var(--dshsm-src-openai)}
.dshsm-pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:99px;font-size:11px;font-weight:500;border:1px solid transparent;white-space:nowrap}
.dshsm-pill.dshsm-run{background:var(--dshsm-accent-weak);color:var(--dshsm-accent)}
.dshsm-pill.dshsm-run::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;animation:dshsm-pulse 1.6s ease-in-out infinite}
.dshsm-pill.dshsm-arch{background:var(--dshsm-surface-2);border-color:var(--dshsm-border);color:var(--dshsm-text-2)}
.dshsm-pill.dshsm-ok{background:var(--dshsm-ok-weak);color:var(--dshsm-ok)}
.dshsm-pill.dshsm-fail{background:var(--dshsm-danger-weak);color:var(--dshsm-danger)}
@keyframes dshsm-pulse{50%{opacity:.25}}
.dshsm-rulechip{display:inline-block;padding:1px 7px;margin:1px 3px 1px 0;border-radius:5px;background:var(--dshsm-surface-2);border:1px solid var(--dshsm-border);font-size:11px;color:var(--dshsm-text-2);white-space:nowrap}

/* ---------- table ---------- */
.dshsm-tblwrap{overflow-x:auto;border:1px solid var(--dshsm-border);border-radius:10px}
.dshsm-tblwrap.dshsm-table-state-loading{position:relative;overflow:hidden}
.dshsm-table-loading{position:absolute;inset:0;z-index:2;display:grid;place-items:center;background:rgba(255,255,255,.74);backdrop-filter:blur(1px);pointer-events:auto}
.dshsm-table-loading[hidden]{display:none}
.dshsm-table-loading-inner{display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--dshsm-text-2);font-size:13px;text-align:center;pointer-events:none}
.dshsm-table-loading-inner svg{color:var(--dshsm-accent)}
.dshsm-list{width:100%;min-width:840px;border-collapse:collapse;font-size:13px}
.dshsm-list.dshsm-compact{min-width:700px}
.dshsm-list th{background:var(--dshsm-surface-2);font-size:11px;font-weight:600;color:var(--dshsm-text-3);text-align:left;letter-spacing:.03em;padding:8px 12px;border-bottom:1px solid var(--dshsm-border);white-space:nowrap}
.dshsm-list td{padding:10px 12px;border-bottom:1px solid var(--dshsm-border);vertical-align:middle}
.dshsm-list tbody tr:last-child td{border-bottom:none}
.dshsm-list tbody tr{transition:background .12s}
.dshsm-list tbody tr:hover{background:var(--dshsm-surface-2)}
.dshsm-list tbody tr.dshsm-clickable{cursor:pointer}
.dshsm-num,.dshsm-list th.dshsm-num{text-align:right;font-family:var(--dshsm-mono);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshsm-list td.dshsm-dim{color:var(--dshsm-text-2);white-space:nowrap}
.dshsm-cell-title{max-width:300px;min-width:180px}
.dshsm-cell-title .dshsm-t{font-weight:500;color:var(--dshsm-text);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dshsm-cell-path{font-family:var(--dshsm-mono);font-size:11px;color:var(--dshsm-text-2);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsm-rowbtns{display:flex;gap:4px;justify-content:flex-end;opacity:0;transition:opacity .12s}
.dshsm-list tr:hover .dshsm-rowbtns,.dshsm-list tr:focus-within .dshsm-rowbtns{opacity:1}
@media (hover:none){.dshsm-rowbtns{opacity:1}}
.dshsm-rowbtns .dshsm-btn{height:26px;padding:0 9px;font-size:12px;border-color:transparent;background:none;color:var(--dshsm-text-2)}
.dshsm-rowbtns .dshsm-btn:hover{background:var(--dshsm-surface-2);color:var(--dshsm-text)}
.dshsm-rowbtns .dshsm-btn.dshsm-del:hover{background:var(--dshsm-danger-weak);color:var(--dshsm-danger)}
.dshsm-list.dshsm-session-list{min-width:0;table-layout:fixed}
.dshsm-session-list th:nth-child(1){width:34px}
.dshsm-session-list th:nth-child(3){width:116px}
.dshsm-session-list th:nth-child(4){width:100px}
.dshsm-session-list th:nth-child(5){width:144px}
.dshsm-session-list .dshsm-cell-title{max-width:none;min-width:0}
.dshsm-session-list td:nth-child(3){white-space:nowrap}
.dshsm-session-list td:last-child{white-space:nowrap}
.dshsm-locknote{font-size:11px;color:var(--dshsm-text-3);white-space:nowrap}

/* ---------- checkbox ---------- */
.dshsm input[type="checkbox"]{appearance:none;-webkit-appearance:none;width:15px;height:15px;border:1.5px solid var(--dshsm-border-strong);border-radius:4.5px;background:var(--dshsm-surface);cursor:pointer;position:relative;transition:background .12s,border-color .12s;flex:none}
.dshsm input[type="checkbox"]:hover{border-color:var(--dshsm-accent)}
.dshsm input[type="checkbox"]:checked{background:var(--dshsm-accent-solid);border-color:var(--dshsm-accent-solid)}
.dshsm input[type="checkbox"]:checked::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(42deg)}
.dshsm input[type="checkbox"]:disabled{opacity:.4;cursor:not-allowed}
.dshsm input[type="checkbox"]:indeterminate{background:var(--dshsm-accent-solid);border-color:var(--dshsm-accent-solid)}
.dshsm input[type="checkbox"]:indeterminate::after{content:"";position:absolute;left:3px;right:3px;top:5px;height:2px;background:#fff;border:none;transform:none}
.dshsm .dshsm-icon-btn{width:32px;height:32px;padding:0;justify-content:center;flex:none}
.dshsm .dshsm-icon-btn[aria-pressed="true"]{color:var(--dshsm-accent);background:var(--dshsm-accent-weak)}

/* ---------- selection bar / alerts / hints ---------- */
.dshsm-selbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;margin-bottom:10px;background:var(--dshsm-surface-2);border:1px solid var(--dshsm-border);border-radius:10px;animation:dshsm-slidedown .18s ease-out}
@keyframes dshsm-slidedown{from{opacity:0;transform:translateY(-4px)}}
.dshsm-selmeta{font-size:13px;color:var(--dshsm-text)}
.dshsm-selmeta b{font-family:var(--dshsm-mono);font-size:12.5px}
.dshsm-alert{display:flex;align-items:flex-start;gap:9px;padding:10px 12px;border-radius:10px;font-size:12.5px;margin-bottom:10px;border:1px solid}
.dshsm-alert svg{flex:none;margin-top:1px}
.dshsm-alert.dshsm-error{background:var(--dshsm-danger-weak);border-color:var(--dshsm-danger-border);color:var(--dshsm-danger)}
.dshsm-alert .dshsm-alert-act{margin-left:auto;font-weight:600;text-decoration:underline;text-underline-offset:3px;color:inherit}
.dshsm-hint{font-size:11.5px;color:var(--dshsm-text-3);margin:-4px 0 10px}

/* ---------- empty & skeleton ---------- */
.dshsm-empty{padding:52px 20px;text-align:center;color:var(--dshsm-text-3)}
.dshsm-empty .dshsm-empty-icon{width:46px;height:46px;margin:0 auto 12px;border-radius:50%;background:var(--dshsm-surface-2);display:grid;place-items:center}
.dshsm-empty .dshsm-empty-t{font-size:14px;font-weight:600;color:var(--dshsm-text-2);margin-bottom:3px}
.dshsm-empty .dshsm-empty-s{font-size:12px}
.dshsm-skel{padding:6px 0}
.dshsm-skel .dshsm-skel-row{height:40px;margin:6px 12px;border-radius:8px;background:linear-gradient(100deg,var(--dshsm-surface-2) 40%,var(--dshsm-mono-bg) 50%,var(--dshsm-surface-2) 60%);background-size:200% 100%;animation:dshsm-shimmer 1.2s infinite}
@keyframes dshsm-shimmer{to{background-position:-200% 0}}

/* ---------- source dropdown (import) ---------- */
.dshsm-dropdown{position:relative;display:inline-block}
.dshsm-dd-btn{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:1px solid var(--dshsm-border);border-radius:8px;background:var(--dshsm-surface);font-size:13px;font-weight:500;transition:border-color .15s,box-shadow .15s}
.dshsm-dd-btn:hover{border-color:var(--dshsm-border-strong)}
.dshsm-dd-btn[aria-expanded="true"]{border-color:var(--dshsm-accent);box-shadow:0 0 0 3px var(--dshsm-accent-weak)}
.dshsm-dd-btn .dshsm-dd-icon{display:grid;place-items:center}
.dshsm-dd-btn .dshsm-dd-icon svg{width:15px;height:15px}
.dshsm-dd-btn .dshsm-chev{color:var(--dshsm-text-3);transition:transform .15s}
.dshsm-dd-btn[aria-expanded="true"] .dshsm-chev{transform:rotate(180deg)}
.dshsm-dd-btn.dshsm-icononly{gap:6px;padding:0 8px}
.dshsm-dd-btn.dshsm-icononly .dshsm-dd-icon svg{width:16px;height:16px}
.dshsm-session-toolbar .dshsm-session-source,.dshsm-session-toolbar .dshsm-session-workspace{flex:0 0 auto}
.dshsm-session-toolbar .dshsm-session-status{flex:0 0 auto}
.dshsm-session-toolbar .dshsm-session-source .dshsm-dd-btn,.dshsm-session-toolbar .dshsm-session-workspace .dshsm-dd-btn{width:51px;justify-content:center}
.dshsm-session-toolbar .dshsm-session-status .dshsm-dd-btn{width:116px;justify-content:center}
.dshsm-session-toolbar .dshsm-session-refresh{flex:0 0 71px;justify-content:center}
.dshsm-dd-menu{position:absolute;top:calc(100% + 5px);left:0;z-index:30;min-width:216px;background:var(--dshsm-surface);border:1px solid var(--dshsm-border);border-radius:11px;box-shadow:var(--dshsm-shadow);padding:5px;animation:dshsm-slidedown .16s ease-out}
.dshsm-dd-item{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border-radius:8px;font-size:13px;text-align:left;color:var(--dshsm-text)}
.dshsm-dd-item:hover{background:var(--dshsm-surface-2)}
.dshsm-dd-item .dshsm-dd-check{width:16px;flex:none;color:var(--dshsm-accent);display:grid;place-items:center}
.dshsm-dd-item .dshsm-dd-icon{width:16px;flex:none;display:grid;place-items:center}
.dshsm-dd-item .dshsm-dd-icon svg{width:14px;height:14px}
.dshsm-dd-menu{max-height:320px;overflow-y:auto;max-width:min(420px,80vw)}
.dshsm-dd-copy{min-width:0;overflow-wrap:anywhere}
.dshsm-dd-copy small{display:block;font-size:11px;color:var(--dshsm-text-3);margin-top:2px}

/* ---------- report cards ---------- */
.dshsm-report{border:1px solid var(--dshsm-border);border-radius:10px;overflow:hidden;margin-bottom:12px;animation:dshsm-slidedown .2s ease-out}
.dshsm-report-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;background:var(--dshsm-surface-2);border-bottom:1px solid var(--dshsm-border);font-size:13px;font-weight:600;color:var(--dshsm-text)}
.dshsm-report ul{list-style:none;max-height:200px;overflow-y:auto;padding:6px 0}
.dshsm-report li{display:flex;gap:8px;align-items:baseline;padding:4px 12px;font-size:12px;color:var(--dshsm-text-2);flex-wrap:wrap}
.dshsm-report li .dshsm-mono{font-size:11px}
.dshsm-report li .dshsm-arrow{color:var(--dshsm-text-3)}
.dshsm-report li .dshsm-reason{color:var(--dshsm-text-3)}
.dshsm-report li.dshsm-fail{color:var(--dshsm-danger)}

/* ---------- stats / cleanup ---------- */
.dshsm-sect{font-size:13.5px;font-weight:700;margin:4px 0 10px;letter-spacing:-.005em;color:var(--dshsm-text)}
.dshsm-cleanwrap .dshsm-sect:not(:first-child){margin-top:22px}
.dshsm-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.dshsm-tile{border:1px solid var(--dshsm-border);border-radius:11px;padding:12px 14px;background:var(--dshsm-surface)}
.dshsm-tile .dshsm-tile-label{font-size:11.5px;color:var(--dshsm-text-3)}
.dshsm-tile .dshsm-tile-value{font-family:var(--dshsm-mono);font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em;margin-top:2px;color:var(--dshsm-text)}
.dshsm-tile .dshsm-tile-sub{font-size:11px;color:var(--dshsm-text-3);margin-top:1px}
.dshsm-storebar{border:1px solid var(--dshsm-border);border-radius:11px;padding:14px;margin-bottom:12px}
.dshsm-bar{display:flex;gap:2px;height:10px;border-radius:5px;overflow:hidden;margin-bottom:12px}
.dshsm-bar span{display:block;min-width:6px}
.dshsm-legend{display:flex;flex-direction:column;gap:6px}
.dshsm-legend .dshsm-li{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dshsm-text)}
.dshsm-legend .dshsm-swatch{width:9px;height:9px;border-radius:3px;flex:none}
.dshsm-legend .dshsm-n{color:var(--dshsm-text-2)}
.dshsm-legend .dshsm-v{margin-left:auto;font-family:var(--dshsm-mono);font-size:11.5px;color:var(--dshsm-text-2);font-variant-numeric:tabular-nums}
.dshsm-metrics{border:1px solid var(--dshsm-border);border-radius:11px;margin-bottom:22px;overflow:hidden}
.dshsm-metrics summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:10px 14px;font-size:12.5px;font-weight:600;color:var(--dshsm-text-2);user-select:none}
.dshsm-metrics summary::-webkit-details-marker{display:none}
.dshsm-metrics summary svg{transition:transform .15s;color:var(--dshsm-text-3)}
.dshsm-metrics[open] summary svg{transform:rotate(180deg)}
.dshsm-metrics summary:hover{background:var(--dshsm-surface-2)}
.dshsm-metrics .dshsm-metrics-inner{border-top:1px solid var(--dshsm-border)}
.dshsm-rules{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--dshsm-border);border-radius:11px;padding:12px 14px;margin-bottom:14px}
.dshsm-rulefield{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--dshsm-text-2)}
.dshsm-rulefield input{width:66px;height:32px;padding:0 9px;font-family:var(--dshsm-mono);font-size:12.5px;background:var(--dshsm-surface);border:1px solid var(--dshsm-border);border-radius:8px;outline:none;color:var(--dshsm-text)}
.dshsm-rulefield input:focus{border-color:var(--dshsm-accent);box-shadow:0 0 0 3px var(--dshsm-accent-weak)}
.dshsm-check{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--dshsm-text-2);cursor:pointer}
.dshsm-preview{border:1px solid var(--dshsm-danger-border);border-radius:12px;overflow:hidden;margin-bottom:14px;animation:dshsm-slidedown .2s ease-out}
.dshsm-preview-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 14px;background:var(--dshsm-danger-weak);border-bottom:1px solid var(--dshsm-danger-border)}
.dshsm-preview-head .dshsm-sum{font-size:13px;font-weight:600;color:var(--dshsm-danger)}
.dshsm-preview-head .dshsm-sum .dshsm-light{font-weight:400;color:var(--dshsm-text-2)}
.dshsm-preview .dshsm-list{min-width:760px}
.dshsm-preview .dshsm-list th{background:var(--dshsm-surface)}
.dshsm-preview-excluded{padding:9px 14px;border-bottom:1px solid var(--dshsm-danger-border);font-size:12px;color:var(--dshsm-danger);background:var(--dshsm-surface)}

/* ---------- drawer ---------- */
.dshsm-scrim{position:fixed;inset:0;background:var(--dshsm-scrim);opacity:0;transition:opacity .2s;z-index:10040}
.dshsm-scrim.dshsm-show{opacity:1}
.dshsm-drawer{position:fixed;top:0;right:0;bottom:0;width:min(460px,94vw);z-index:10050;background:var(--dshsm-surface);border-left:1px solid var(--dshsm-border);transform:translateX(103%);transition:transform .24s cubic-bezier(.2,.7,.3,1);display:flex;flex-direction:column;box-shadow:-24px 0 48px -24px rgba(0,0,0,.25);font-family:var(--dshsm-ui);font-size:13px;line-height:1.55;color:var(--dshsm-text)}
.dshsm-drawer.dshsm-show{transform:translateX(0)}
.dshsm-drawer-head{display:flex;align-items:flex-start;gap:10px;padding:18px 18px 12px;border-bottom:1px solid var(--dshsm-border)}
.dshsm-drawer-head h2{font-size:15px;font-weight:700;line-height:1.4;letter-spacing:-.01em;color:var(--dshsm-text);overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.dshsm-drawer-src{margin-top:6px}
.dshsm-drawer-close{margin-left:auto;flex:none;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:var(--dshsm-text-3)}
.dshsm-drawer-close:hover{background:var(--dshsm-surface-2);color:var(--dshsm-text)}
.dshsm-drawer-meta{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;padding:14px 18px;border-bottom:1px solid var(--dshsm-border)}
.dshsm-drawer-meta .dshsm-k{font-size:11px;color:var(--dshsm-text-3)}
.dshsm-drawer-meta .dshsm-v{font-size:12.5px;margin-top:1px;color:var(--dshsm-text)}
.dshsm-drawer-meta .dshsm-v.dshsm-mono{font-size:11px;word-break:break-all}
.dshsm-drawer-actions{display:flex;gap:8px;padding:12px 18px;border-bottom:1px solid var(--dshsm-border)}
.dshsm-drawer-actions .dshsm-btn.dshsm-primary{background:var(--dshsm-accent-solid);color:var(--dshsm-accent-on);border-color:transparent}
.dshsm-drawer-actions .dshsm-btn.dshsm-ghost{border-color:var(--dshsm-border);background:var(--dshsm-surface)}
.dshsm-events{flex:1;overflow-y:auto;padding:14px 18px 20px;display:flex;flex-direction:column;gap:10px}
.dshsm-events .dshsm-etitle{font-size:11px;color:var(--dshsm-text-3);letter-spacing:.06em;font-family:var(--dshsm-mono);text-transform:uppercase}
.dshsm-ev{display:flex;gap:9px;align-items:flex-start}
.dshsm-ev-type{flex:none;font-family:var(--dshsm-mono);font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;padding:2px 6px;border-radius:5px;margin-top:2px;border:1px solid transparent;min-width:64px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}
.dshsm-ev-type.dshsm-user{background:var(--dshsm-accent-weak);color:var(--dshsm-accent)}
.dshsm-ev-type.dshsm-assistant{background:var(--dshsm-surface-2);color:var(--dshsm-text-2);border-color:var(--dshsm-border)}
.dshsm-ev-type.dshsm-tool{background:none;border-color:var(--dshsm-border-strong);color:var(--dshsm-text-2)}
.dshsm-ev-type.dshsm-other{background:none;color:var(--dshsm-text-3)}
.dshsm-ev-body{font-size:12px;color:var(--dshsm-text-2);font-family:var(--dshsm-mono);overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;word-break:break-word}
.dshsm-ev-more{font-size:11px;color:var(--dshsm-text-3)}

/* ---------- confirm modal ---------- */
.dshsm-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);z-index:10060;width:min(380px,92vw);background:var(--dshsm-surface);border:1px solid var(--dshsm-border);border-radius:14px;box-shadow:var(--dshsm-shadow);padding:20px;opacity:0;transition:opacity .16s,transform .16s;font-family:var(--dshsm-ui);font-size:13px;line-height:1.55;color:var(--dshsm-text)}
.dshsm-modal.dshsm-show{opacity:1;transform:translate(-50%,-50%) scale(1)}
.dshsm-modal .dshsm-m-icon{width:38px;height:38px;border-radius:10px;background:var(--dshsm-danger-weak);color:var(--dshsm-danger);display:grid;place-items:center;margin-bottom:12px}
.dshsm-modal h3{font-size:15px;font-weight:700;letter-spacing:-.01em;margin-bottom:5px;color:var(--dshsm-text)}
.dshsm-modal p{font-size:12.5px;color:var(--dshsm-text-2);line-height:1.6}
.dshsm-modal p b{font-weight:600;color:var(--dshsm-text)}
.dshsm-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.dshsm-modal-actions .dshsm-btn.dshsm-danger{background:var(--dshsm-danger);color:#fff}
.dshsm-modal-actions .dshsm-btn.dshsm-ghost{border-color:var(--dshsm-border);background:var(--dshsm-surface)}

/* ---------- toasts ---------- */
.dshsm-toasts{position:fixed;right:18px;bottom:18px;z-index:10070;display:flex;flex-direction:column;gap:8px}
.dshsm-toast{display:flex;align-items:center;gap:9px;padding:10px 14px;border-radius:10px;font-size:13px;background:#1F242C;color:#F2F4F7;box-shadow:var(--dshsm-shadow);animation:dshsm-toastin .2s ease-out;max-width:340px;font-family:var(--dshsm-ui)}
@keyframes dshsm-toastin{from{opacity:0;transform:translateY(8px)}}
.dshsm-toast.dshsm-out{opacity:0;transform:translateY(6px);transition:opacity .25s,transform .25s}
.dshsm-toast .dshsm-dot{width:7px;height:7px;border-radius:50%;flex:none}
.dshsm-toast.dshsm-ok .dshsm-dot{background:#57C08A}
.dshsm-toast.dshsm-err .dshsm-dot{background:#E46A6A}

@media (prefers-reduced-motion:reduce){
  .dshsm *,.dshsm-overlay-root *{animation:none!important;transition:none!important}
}
`

    /* sprite：品牌 logo（assets/logo，viewBox 已按墨水占比归一化）+ 界面图标 */
    const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="dshsm-i-claude" viewBox="0 0 1024 1024"><path fill="currentColor" d="M229.0688 665.4464l183.1424-102.7072 3.1232-8.9088-3.1232-4.9664h-8.9088l-30.6688-1.8432-104.704-2.816-90.7776-3.7888-87.9104-4.7104-22.1696-4.7104-20.7872-27.3408 2.1504-13.6704 18.6368-12.4416 26.624 2.304 58.9824 3.9936 88.3712 6.144 64.1024 3.7888 95.0272 9.8816h15.104l2.1504-6.0928-5.2224-3.7888-3.9936-3.7888-91.4944-61.952-99.0208-65.4848-51.8144-37.7344-28.1088-19.0464-14.1312-17.92-6.144-39.1168 25.4464-28.0064 34.2016 2.304 8.7552 2.3552 34.6624 26.624 74.0352 57.2928L391.2704 380.416l14.1824 11.776 5.632-3.9936 0.7168-2.816-6.3488-10.6496-52.5824-94.9248-56.1152-96.6144-24.9856-40.0384-6.6048-24.0128c-2.5088-9.216-3.8912-18.7392-4.0448-28.2624l29.0304-39.3216 16.0256-5.2224 38.656 5.2224 16.2816 14.1312 24.064 54.8864 38.8608 86.4768L484.352 324.608l17.7152 34.8672 9.4208 32.3072 3.5328 9.8816h6.144v-5.6832l4.9664-66.2016 9.216-81.3056 8.9088-104.5504 3.1232-29.4912 14.592-35.328 28.9792-19.0976 22.6816 10.8544 18.6368 26.5728-2.6112 17.2032-11.1104 71.8336-21.7088 112.64-14.1312 75.3664h8.2432l9.4208-9.3696 38.1952-50.688 64.1024-80.0768 28.3136-31.7952 32.9728-35.072 21.248-16.7424h40.0896l29.4912 43.8272-13.2096 45.2608-41.2672 52.2752-34.2016 44.288-49.0496 65.9456-30.6688 52.7872 2.816 4.2496 7.2704-0.768 110.7968-23.5008 59.8528-10.8544 71.424-12.2368 32.3072 15.0528 3.5328 15.3088-12.7488 31.3344-76.3904 18.8416-89.6 17.92-133.4272 31.5392-1.6384 1.1776 1.8944 2.3552 60.1088 5.6832 25.7024 1.3824h62.9248l117.1968 8.7552 30.6688 20.2752 18.3808 24.7808-3.072 18.8416-47.1552 24.064-63.6416-15.104-148.5824-35.328-50.8928-12.7488h-7.0656v4.2496l42.3936 41.4208 77.824 70.2464 97.3312 90.4192 4.9152 22.4256-12.4928 17.664-13.2096-1.8944-85.5552-64.3072-33.024-28.9792-74.752-62.8736h-4.9664v6.6048l17.2032 25.1904 90.9824 136.6016 4.7104 41.8816-6.6048 13.7216-23.6032 8.2432-25.9072-4.7104-53.2992-74.7008-54.8864-84.0704-44.3392-75.4176-5.4272 3.1232-26.1632 281.4976-12.2368 14.336-28.2624 10.8544-23.552-17.8688-12.4928-28.9792 12.4928-57.2928 15.104-74.6496 12.2368-59.392 11.1104-73.728 6.6048-24.5248-0.4608-1.6384-5.4272 0.7168-55.6544 76.3392-84.5824 114.2784-66.9696 71.5776-16.0768 6.3488-27.8016-14.336 2.6112-25.7024 15.5648-22.8352 92.672-117.8112 55.8592-73.0112 36.096-42.1376-0.256-6.144h-2.1504l-246.1184 159.6928-43.8272 5.6832-18.8928-17.7152 2.3552-28.928 8.96-9.4208 74.0352-50.8928-0.256 0.256z"/></symbol>
    <symbol id="dshsm-i-openai" viewBox="151.6 142.1 720.2 720.2"><path fill="currentColor" d="M765.074286 449.243429a143.030857 143.030857 0 0 0-12.8-119.478858 150.052571 150.052571 0 0 0-160.548572-70.692571c-77.129143-84.370286-216.502857-55.222857-253.330285 53.028571a147.529143 147.529143 0 0 0-98.596572 70.656 145.481143 145.481143 0 0 0 18.358857 172.397715 142.994286 142.994286 0 0 0 12.726857 119.478857 150.089143 150.089143 0 0 0 160.585143 70.692571c77.165714 84.406857 216.576 55.149714 253.330286-53.138285a147.382857 147.382857 0 0 0 98.56-70.692572 145.005714 145.005714 0 0 0-18.285714-172.324571v0.073143z m-222.354286 306.761142a111.616 111.616 0 0 1-70.985143-25.380571c0.914286-0.512 2.413714-1.243429 3.510857-1.974857l117.76-67.181714a18.432 18.432 0 0 0 9.764572-16.566858V480.914286l49.664 28.598857a1.28 1.28 0 0 1 0.914285 1.28v135.789714a110.262857 110.262857 0 0 1-110.592 109.494857v-0.109714z m-238.372571-100.388571a108.141714 108.141714 0 0 1-13.348572-73.325714c1.097143 0.731429 2.304 1.389714 3.510857 1.974857l117.833143 67.145143a19.273143 19.273143 0 0 0 19.492572 0l143.835428-81.92v56.758857a1.499429 1.499429 0 0 1-0.731428 1.462857L455.789714 695.588571a111.908571 111.908571 0 0 1-151.442285-39.972571z m-31.085715-253.878857A109.312 109.312 0 0 1 330.971429 353.718857V492.251429a19.309714 19.309714 0 0 0 9.581714 16.530285l143.835428 81.993143-49.737142 28.196572a1.792 1.792 0 0 1-1.645715 0.182857l-119.113143-67.84a108.873143 108.873143 0 0 1-40.594285-149.577143l-0.036572 0.036571z m409.417143 94.025143l-143.872-81.993143 49.773714-28.452572a1.828571 1.828571 0 0 1 1.462858-0.109714L709.12 453.12a108.580571 108.580571 0 0 1 40.484571 149.504 110.994286 110.994286 0 0 1-57.709714 48.018286V512a17.92 17.92 0 0 0-9.472-16.347429l0.219429 0.109715z m49.627429-73.728c-0.987429-0.585143-2.450286-1.462857-3.547429-2.011429L610.742857 352.841143a19.492571 19.492571 0 0 0-19.492571 0L447.451429 434.834286V378.038857a1.572571 1.572571 0 0 1 0.731428-1.462857l119.222857-67.913143a111.762286 111.762286 0 0 1 151.405715 40.155429c13.019429 22.052571 17.737143 47.981714 13.348571 73.142857l0.146286 0.073143z m-311.808 101.156571l-49.737143-28.269714a1.389714 1.389714 0 0 1-0.950857-1.28V357.741714a111.104 111.104 0 0 1 181.796571-83.894857c-0.914286 0.512-2.413714 1.28-3.510857 1.974857L430.262857 342.966857a18.285714 18.285714 0 0 0-9.581714 16.603429l-0.182857 163.547428v0.073143z m26.989714-57.526857l64.109714-36.571429 64.219429 36.571429v72.996571l-64.036572 36.571429-64.182857-36.571429-0.182857-72.996571h0.073143z"/></symbol>
    <symbol id="dshsm-i-deepseek" viewBox="-145.5 -51.4 1174.3 1174.3"><path fill="currentColor" d="M929.706667 254.122667c-9.045333-4.352-12.928 3.968-18.218667 8.192-1.792 1.365333-3.328 3.157333-4.864 4.778666-13.226667 13.952-28.629333 23.082667-48.810667 21.973334-29.44-1.621333-54.613333 7.509333-76.885333 29.781333-4.736-27.434667-20.48-43.818667-44.373333-54.357333-12.501333-5.461333-25.173333-10.922667-33.92-22.784-6.144-8.448-7.808-17.92-10.88-27.178667-1.92-5.546667-3.84-11.306667-10.410667-12.288-7.082667-1.066667-9.856 4.778667-12.672 9.685333-11.093333 20.053333-15.402667 42.24-15.018667 64.597334 0.981333 50.346667 22.528 90.538667 65.365334 119.04 4.864 3.285333 6.144 6.570667 4.608 11.349333-2.944 9.813333-6.4 19.370667-9.472 29.226667-1.92 6.272-4.864 7.637333-11.690667 4.906666a196.608 196.608 0 0 1-61.738667-41.386666c-30.421333-29.056-57.984-61.141333-92.330666-86.272a403.2 403.2 0 0 0-24.490667-16.512c-34.986667-33.578667 4.608-61.184 13.781333-64.426667 9.6-3.413333 3.328-15.189333-27.648-15.018667-31.018667 0.128-59.392 10.368-95.573333 24.021334a109.653333 109.653333 0 0 1-16.512 4.778666 345.685333 345.685333 0 0 0-102.528-3.584c-66.986667 7.381333-120.533333 38.656-159.914667 92.032-47.274667 64.170667-58.410667 137.088-44.8 213.12 14.378667 80.128 55.808 146.474667 119.466667 198.4 66.090667 53.76 142.165333 80.128 228.906667 75.093334 52.736-2.986667 111.402667-9.984 177.578666-65.28 16.725333 8.192 34.218667 11.477333 63.317334 13.909333 22.357333 2.048 43.946667-1.066667 60.586666-4.48 26.154667-5.461333 24.32-29.354667 14.933334-33.706667-76.672-35.242667-59.818667-20.906667-75.093334-32.512 38.912-45.482667 97.578667-92.714667 120.533334-245.76 1.792-12.16 0.298667-19.797333 0-29.610666-0.128-6.016 1.28-8.32 8.192-9.045334a149.76 149.76 0 0 0 54.954666-16.64c49.621333-26.752 69.674667-70.698667 74.410667-123.434666 0.682667-8.021333-0.170667-16.384-8.789333-20.608zM497.066667 728.405333c-74.24-57.6-110.250667-76.586667-125.141334-75.733333-13.909333 0.810667-11.392 16.512-8.32 26.752 3.2 10.112 7.338667 17.066667 13.226667 25.941333 4.010667 5.845333 6.784 14.592-4.053333 21.162667-23.893333 14.592-65.493333-4.949333-67.456-5.888-48.384-28.117333-88.874667-65.28-117.376-116.053333-27.52-48.853333-43.52-101.290667-46.165334-157.269334-0.682667-13.525333 3.328-18.304 16.981334-20.736 17.92-3.285333 36.437333-3.968 54.357333-1.365333 75.776 10.922667 140.330667 44.373333 194.389333 97.322667 30.890667 30.165333 54.272 66.218667 78.293334 101.461333 25.6 37.376 53.162667 73.045333 88.192 102.229333 12.373333 10.24 22.229333 18.048 31.701333 23.765334-28.501333 3.157333-76.074667 3.84-108.629333-21.589334z m35.626666-225.92a10.837333 10.837333 0 0 1 14.72-10.112 9.728 9.728 0 0 1 4.053334 2.56 10.837333 10.837333 0 0 1-7.936 18.304 10.709333 10.709333 0 0 1-10.837334-10.752z m110.549334 55.978667a65.024 65.024 0 0 1-20.992 5.546667 44.672 44.672 0 0 1-28.373334-8.832c-9.728-8.064-16.682667-12.544-19.626666-26.624-1.237333-5.973333-0.554667-15.274667 0.597333-20.608 2.474667-11.477333-0.298667-18.858667-8.533333-25.557334-6.656-5.461333-15.146667-6.954667-24.448-6.954666a20.053333 20.053333 0 0 1-9.045334-2.730667c-3.882667-1.92-7.082667-6.698667-4.010666-12.544a40.021333 40.021333 0 0 1 6.826666-7.381333c12.629333-7.082667 27.221333-4.778667 40.704 0.554666 12.544 5.034667 21.973333 14.336 35.626667 27.434667 13.909333 15.829333 16.384 20.224 24.32 32.085333 6.272 9.301333 11.946667 18.858667 15.872 29.781334 2.346667 6.826667-0.725333 12.373333-8.917333 15.786666z"/></symbol>
    <symbol id="dshsm-i-search" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4-4"/></g></symbol>
    <symbol id="dshsm-i-folder" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></symbol>
    <symbol id="dshsm-i-refresh" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4v6h-6"/><path d="M21 10a9 9 0 1 0 .5 4"/></g></symbol>
    <symbol id="dshsm-i-trash" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></g></symbol>
    <symbol id="dshsm-i-open" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></g></symbol>
    <symbol id="dshsm-i-x" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></g></symbol>
    <symbol id="dshsm-i-check" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.5 5 5 10-11"/></symbol>
    <symbol id="dshsm-i-chev" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></symbol>
    <symbol id="dshsm-i-inbox" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></g></symbol>
    <symbol id="dshsm-i-warn" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></g></symbol>
    <symbol id="dshsm-i-layers" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></g></symbol>
    <symbol id="dshsm-i-status" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><path d="M11 5h10M11 12h10M11 19h10"/></g></symbol>
    <symbol id="dshsm-i-active" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></g></symbol>
    <symbol id="dshsm-i-archive" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v12h14V8M10 12h4"/></g></symbol>
  </defs>
</svg>`

    function ensureClientChrome() {
      if (!document.getElementById('dshsm-style')) {
        const style = document.createElement('style')
        style.id = 'dshsm-style'
        style.textContent = STYLE
        document.head.appendChild(style)
      }
      if (!document.getElementById('dshsm-sprite')) {
        const holder = document.createElement('div')
        holder.id = 'dshsm-sprite'
        holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
        holder.innerHTML = SPRITE
        document.body.appendChild(holder)
      }
      if (!document.getElementById('dshsm-overlay-root')) {
        const layer = document.createElement('div')
        layer.id = 'dshsm-overlay-root'
        layer.className = 'dshsm-overlay-root'
        document.body.appendChild(layer)
      }
    }

    function overlayRoot() { return document.getElementById('dshsm-overlay-root') }

    /* ================= imperative overlays ================= */

    function svgUse(name, size, cls) {
      return `<svg ${cls ? `class="${cls}" ` : ''}width="${size}" height="${size}" aria-hidden="true"><use href="#dshsm-i-${name}"/></svg>`
    }

    function toast(message, type) {
      const root = overlayRoot()
      if (!root) return
      let box = root.querySelector('.dshsm-toasts')
      if (!box) {
        box = document.createElement('div')
        box.className = 'dshsm-toasts'
        root.appendChild(box)
      }
      const el = document.createElement('div')
      el.className = `dshsm-toast dshsm-${type === 'err' ? 'err' : 'ok'}`
      el.innerHTML = `<span class="dshsm-dot"></span><span></span>`
      el.lastElementChild.textContent = String(message)
      box.appendChild(el)
      setTimeout(() => {
        el.classList.add('dshsm-out')
        setTimeout(() => el.remove(), 300)
      }, 3400)
    }

    /** Promise-based destructive-action confirmation. Resolves true on confirm. */
    function confirmDialog({ title = '确认操作', desc = '', confirmText = '删除' }) {
      const root = overlayRoot()
      if (!root) return Promise.resolve(false)
      return new Promise((resolve) => {
        const scrim = document.createElement('div')
        scrim.className = 'dshsm-scrim'
        const modal = document.createElement('div')
        modal.className = 'dshsm-modal'
        modal.setAttribute('role', 'dialog')
        modal.setAttribute('aria-modal', 'true')
        modal.innerHTML = `
          <div class="dshsm-m-icon">${svgUse('trash', 17)}</div>
          <h3></h3>
          <p></p>
          <div class="dshsm-modal-actions">
            <button type="button" class="dshsm-btn dshsm-ghost dshsm-m-cancel">取消</button>
            <button type="button" class="dshsm-btn dshsm-danger dshsm-m-confirm"></button>
          </div>`
        modal.querySelector('h3').textContent = title
        modal.querySelector('p').innerHTML = desc
        modal.querySelector('.dshsm-m-confirm').textContent = confirmText
        root.appendChild(scrim)
        root.appendChild(modal)
        requestAnimationFrame(() => {
          scrim.classList.add('dshsm-show')
          modal.classList.add('dshsm-show')
        })
        const close = (result) => {
          document.removeEventListener('keydown', onKey, true)
          scrim.remove()
          modal.remove()
          resolve(result)
        }
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false) } }
        document.addEventListener('keydown', onKey, true)
        modal.querySelector('.dshsm-m-confirm').addEventListener('click', () => close(true))
        modal.querySelector('.dshsm-m-cancel').addEventListener('click', () => close(false))
        scrim.addEventListener('click', () => close(false))
        modal.querySelector('.dshsm-m-confirm').focus()
      })
    }

    /** Right-side session preview drawer, fed by the /preview API plus list-row metrics. */
    function previewDrawer({ item, preview, onOpen, onArchive }) {
      const root = overlayRoot()
      if (!root) return () => {}
      const scrim = document.createElement('div')
      scrim.className = 'dshsm-scrim'
      const drawer = document.createElement('aside')
      drawer.className = 'dshsm-drawer'
      drawer.setAttribute('aria-label', '会话预览')
      const srcLabel = sourceLabels[preview.source] || preview.source
      const evTypeClass = (t) => {
        if (t === 'user') return 'dshsm-user'
        if (t === 'assistant') return 'dshsm-assistant'
        if (t && (t.includes('tool') || t.includes('call'))) return 'dshsm-tool'
        return 'dshsm-other'
      }
      const evText = (data) => {
        if (data == null) return ''
        if (typeof data === 'string') return data
        try { return JSON.stringify(data) } catch { return String(data) }
      }
      const events = Array.isArray(preview.events) ? preview.events : []
      const shown = events.slice(0, 200)
      const meta = [
        ['最后活跃', `<span class="dshsm-mono">${esc(absTime(preview.updatedAt || item.updatedAt))}</span>`],
        ['大小', `<span class="dshsm-mono">${esc(formatBytes(item.sizeBytes))}</span>`],
        ['消息数', `<span class="dshsm-mono">${esc(String(item.messageCount))}</span>`],
        ['时长', `<span class="dshsm-mono">${esc(formatDuration(item.durationMs))}</span>`],
        ['工具调用', `<span class="dshsm-mono">${esc(String(item.toolCalls))}（成功 ${esc(String(item.toolSuccess))} / 无结果 ${esc(String(item.toolNoResult))}）</span>`],
        ['工作区', `<span class="dshsm-v dshsm-mono">${esc(preview.cwd || item.cwd || '—')}</span>`],
        ['会话 ID', `<span class="dshsm-v dshsm-mono" style="grid-column:1/-1">${esc(preview.id || item.id)}</span>`],
      ]
      drawer.innerHTML = `
        <div class="dshsm-drawer-head">
          <div style="min-width:0">
            <h2></h2>
            <div class="dshsm-drawer-src"><span class="dshsm-src-chip"><span class="dshsm-src-dot">${svgUse(sourceIconName(preview.source), 12, `dshsm-src-${esc(preview.source)}`)}</span>${esc(srcLabel)}</span></div>
          </div>
          <button type="button" class="dshsm-drawer-close" aria-label="关闭预览">${svgUse('x', 15)}</button>
        </div>
        <div class="dshsm-drawer-meta">${meta.map(([k, v]) => `<div><div class="dshsm-k">${k}</div><div class="dshsm-v-wrap">${v}</div></div>`).join('')}</div>
        <div class="dshsm-drawer-actions">
          <button type="button" class="dshsm-btn dshsm-primary dshsm-drawer-open">${svgUse('open', 13)}<span></span></button>
          <button type="button" class="dshsm-btn dshsm-ghost dshsm-drawer-archive"></button>
        </div>
        <div class="dshsm-events">
          <div class="dshsm-etitle">事件流</div>
          ${shown.map((ev) => `<div class="dshsm-ev"><span class="dshsm-ev-type ${evTypeClass(ev.type)}">${esc(ev.type || 'event')}</span><div class="dshsm-ev-body">${esc(evText(ev.data))}</div></div>`).join('')}
          ${events.length > shown.length ? `<div class="dshsm-ev-more">仅显示前 ${shown.length} 条，共 ${events.length} 条事件。</div>` : ''}
        </div>`
      drawer.querySelector('h2').textContent = preview.title || preview.id
      const openBtn = drawer.querySelector('.dshsm-drawer-open')
      const openLabel = openBtn.querySelector('span')
      openLabel.textContent = preview.running ? '切换到该会话' : '在 DSH 中打开'
      const archiveBtn = drawer.querySelector('.dshsm-drawer-archive')
      if (preview.running) {
        archiveBtn.style.display = 'none'
      } else {
        archiveBtn.textContent = preview.archived ? '取消归档' : '归档'
        archiveBtn.addEventListener('click', () => { close(); onArchive() })
      }
      openBtn.addEventListener('click', () => { close(); onOpen() })
      root.appendChild(scrim)
      root.appendChild(drawer)
      requestAnimationFrame(() => {
        scrim.classList.add('dshsm-show')
        drawer.classList.add('dshsm-show')
      })
      const close = () => {
        document.removeEventListener('keydown', onKey, true)
        scrim.remove()
        drawer.remove()
      }
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
      document.addEventListener('keydown', onKey, true)
      drawer.querySelector('.dshsm-drawer-close').addEventListener('click', close)
      scrim.addEventListener('click', close)
      return close
    }

    function sourceIconName(source) {
      if (source === 'claude-code') return 'claude'
      if (source === 'codex') return 'openai'
      return 'deepseek'
    }

    /* ================= small components ================= */

    function Svg({ name, size = 14, className }) {
      const props = { width: size, height: size, 'aria-hidden': true }
      if (className) props.className = className
      return h('svg', props, h('use', { href: `#dshsm-i-${name}` }))
    }

    function SourceIcon({ source, className }) {
      return h(Svg, { name: sourceIconName(source), className: `dshsm-src-${source || 'dsh'}${className ? ` ${className}` : ''}` })
    }

    function SourceChip({ source }) {
      return h('span', { className: 'dshsm-src-chip' },
        h('span', { className: 'dshsm-src-dot' }, h(SourceIcon, { source })),
        sourceLabels[source] || source)
    }

    const SOURCE_FILTER_OPTIONS = [
      { value: 'all', label: '全部来源', icon: h(Svg, { name: 'layers', size: 14 }) },
      { value: 'dsh', label: 'DSH', icon: h(SourceIcon, { source: 'dsh' }) },
      { value: 'claude-code', label: 'Claude Code', icon: h(SourceIcon, { source: 'claude-code' }) },
      { value: 'codex', label: 'Codex', icon: h(SourceIcon, { source: 'codex' }) },
    ]
    const ARCHIVED_OPTIONS = [
      { value: 'all', label: '全部状态', icon: h(Svg, { name: 'status' }) },
      { value: 'false', label: '活跃', icon: h(Svg, { name: 'active' }) },
      { value: 'true', label: '已归档', icon: h(Svg, { name: 'archive' }) },
    ]
    const IMPORT_SOURCE_OPTIONS = [
      { value: 'claude-code', label: 'Claude Code', icon: h(SourceIcon, { source: 'claude-code' }) },
      { value: 'codex', label: 'Codex', icon: h(SourceIcon, { source: 'codex' }) },
    ]

    function Dropdown({ value, onChange, options, ariaLabel, iconOnly, disabled, className }) {
      const [open, setOpen] = useState(false)
      const ref = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDoc)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDoc)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])
      const current = options.find((o) => o.value === value) || options[0]
      const currentIcon = current && current.icon
      const showLabel = !iconOnly || !currentIcon
      return h('div', { className: 'dshsm-dropdown' + (className ? ` ${className}` : ''), ref },
        h('button', {
          type: 'button',
          className: 'dshsm-dd-btn' + (iconOnly && currentIcon ? ' dshsm-icononly' : ''),
          'aria-haspopup': 'listbox',
          'aria-expanded': String(open),
          'aria-label': ariaLabel,
          disabled,
          title: iconOnly && currentIcon ? (current.description || current.label) : undefined,
          onClick: () => setOpen((v) => !v),
        },
          currentIcon ? h('span', { className: 'dshsm-dd-icon' }, currentIcon) : null,
          showLabel ? h('span', null, current.label) : null,
          h(Svg, { name: 'chev', size: 13, className: 'dshsm-chev' })),
        open ? h('div', { className: 'dshsm-dd-menu', role: 'listbox', 'aria-label': ariaLabel },
          options.map((o) =>
            h('button', {
              type: 'button',
              key: o.value,
              role: 'option',
              'aria-selected': String(o.value === value),
              title: o.description,
              className: 'dshsm-dd-item',
              onClick: () => { setOpen(false); if (o.value !== value) onChange(o.value) },
            },
              h('span', { className: 'dshsm-dd-check' }, o.value === value ? h(Svg, { name: 'check', size: 12 }) : null),
              o.icon ? h('span', { className: 'dshsm-dd-icon' }, o.icon) : h('span', { className: 'dshsm-dd-icon' }),
              h('span', { className: 'dshsm-dd-copy' }, o.label, o.description ? h('small', null, o.description) : null))))
          : null)
    }

    function SelectAllCheckbox({ checked, mixed, disabled, onChange, label }) {
      const ref = useRef(null)
      useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
      return h('input', { ref, type: 'checkbox', checked, disabled, onChange,
        'aria-label': label, 'aria-checked': mixed ? 'mixed' : checked, title: checked ? '取消全选' : '全选' })
    }

    function workspacePath(value) {
      const normalized = (value || '').replace(/\\/g, '/').replace(/\/+$/, '')
      return /^[a-z]:/i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
    }

    function useDebounced(value, ms) {
      const [debounced, setDebounced] = useState(value)
      useEffect(() => {
        const t = setTimeout(() => setDebounced(value), ms)
        return () => clearTimeout(t)
      }, [value, ms])
      return debounced
    }

    function EmptyState({ title, sub }) {
      return h('div', { className: 'dshsm-empty' },
        h('div', { className: 'dshsm-empty-icon' }, h(Svg, { name: 'inbox', size: 20 })),
        h('div', { className: 'dshsm-empty-t' }, title),
        h('div', { className: 'dshsm-empty-s' }, sub))
    }

    function Skeleton({ rows }) {
      return h('div', { className: 'dshsm-skel' },
        Array.from({ length: rows }, (_, i) => h('div', { key: i, className: 'dshsm-skel-row' })))
    }

    /* ================= 会话 tab ================= */

    function SessionsSection({ onTotal, client, close }) {
      const [query, setQuery] = useState('')
      const debouncedQuery = useDebounced(query, 300)
      const [source, setSource] = useState('all')
      const [archived, setArchived] = useState('all')
      const [workspace, setWorkspace] = useState('')
      const [workspaces, setWorkspaces] = useState([])
      const [items, setItems] = useState([])
      const [total, setTotal] = useState(0)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [selected, setSelected] = useState({})
      const [busyId, setBusyId] = useState(null)
      const searchRef = useRef(null)
      const tableRef = useRef(null)
      const loadingRef = useRef(null)
      const loadRef = useRef(0)

      useEffect(() => {
        const store = client.get('workspaces').list
        const update = () => setWorkspaces(store.getSnapshot().items || [])
        update()
        return store.subscribe(update)
      }, [client])
      const workspaceOptions = [
        { value: '', label: '全部工作区', icon: h(Svg, { name: 'folder' }) },
        ...workspaces.map((entry) => ({ value: entry.path, label: entry.title || entry.path.split(/[\\/]/).pop(), description: entry.path, icon: h(Svg, { name: 'folder' }) })),
      ]

      useEffect(() => {
        onTotal?.(null)
      }, [onTotal])

      const load = useCallback(() => {
        const seq = ++loadRef.current
        const params = new URLSearchParams()
        if (debouncedQuery) params.set('query', debouncedQuery)
        if (source !== 'all') params.set('source', source)
        if (archived !== 'all') params.set('archived', archived)
        if (workspace) params.set('cwd', workspace)
        const endpoint = debouncedQuery ? '/search' : '/list'
        setLoading(true)
        setError(null)
        fetchJson(`${API}${endpoint}?${params.toString()}`)
          .then((result) => {
            if (seq !== loadRef.current) return
            setItems(result.items || [])
            setTotal(result.total != null ? result.total : (result.items || []).length)
            onTotal?.(result.total != null ? result.total : (result.items || []).length)
          })
          .catch((err) => {
            if (seq !== loadRef.current) return
            setItems([])
            setError(String(err.message || err))
          })
          .finally(() => {
            if (seq === loadRef.current) setLoading(false)
          })
      }, [debouncedQuery, source, archived, workspace, onTotal])

      useEffect(() => { load() }, [load])

      useEffect(() => {
        if (!loading) return undefined
        const update = () => {
          const node = tableRef.current
          const overlay = loadingRef.current
          if (!node || !overlay) return
          const tableRect = node.getBoundingClientRect()
          let top = tableRect.top
          let right = tableRect.right
          let bottom = tableRect.bottom
          let left = tableRect.left
          for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent)
            if (style.position === 'fixed') break
            if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
            const clip = parent.getBoundingClientRect()
            top = Math.max(top, clip.top)
            right = Math.min(right, clip.right)
            bottom = Math.min(bottom, clip.bottom)
            left = Math.max(left, clip.left)
          }
          top = Math.max(top, 0)
          right = Math.min(right, window.innerWidth)
          bottom = Math.min(bottom, window.innerHeight)
          if (right <= left || bottom <= top) {
            overlay.hidden = true
            return
          }
          overlay.hidden = false
          overlay.style.inset = 'auto'
          overlay.style.top = `${top - tableRect.top}px`
          overlay.style.left = `${left - tableRect.left}px`
          overlay.style.width = `${right - left}px`
          overlay.style.height = `${bottom - top}px`
        }
        update()
        document.addEventListener('scroll', update, true)
        window.addEventListener('resize', update)
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
        if (observer) observer.observe(tableRef.current)
        return () => {
          document.removeEventListener('scroll', update, true)
          window.removeEventListener('resize', update)
          observer?.disconnect()
        }
      }, [loading])

      useEffect(() => {
        const onKey = (e) => {
          if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
          const tag = document.activeElement && document.activeElement.tagName
          if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
          e.preventDefault()
          searchRef.current?.focus()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])

      const openPreview = useCallback((item) => {
        fetchJson(`${API}/preview?id=${encodeURIComponent(item.id)}`)
          .then((preview) => previewDrawer({
            item,
            preview,
            onOpen: () => runOpenRef.current(item),
            onArchive: () => runArchiveRef.current(item.id, preview.archived ? 'unarchive' : 'archive'),
          }))
          .catch((err) => toast(String(err.message || err), 'err'))
      }, [])

      const runArchiveAction = useCallback((id, action) => {
        setBusyId(id)
        postJson(`${API}/${action}`, { sessionId: id })
          .then(() => toast(action === 'unarchive'
            ? '已取消归档，本列表已更新；内置侧栏将在页面刷新后收敛。'
            : '已归档，本列表已更新。'))
          .catch((err) => toast(String(err.message || err), 'err'))
          .finally(() => { setBusyId(null); load() })
      }, [load])
      const runArchiveRef = useRef(runArchiveAction)
      runArchiveRef.current = runArchiveAction

      const runOpen = useCallback((item) => {
        setBusyId(item.id)
        Promise.resolve().then(async () => {
            const sessions = client.get('sessions')
            if (!sessions?.create || !sessions?.open) throw new Error('宿主会话导航不可用')
            const id = await sessions.create({ sessionId: item.id, cwd: item.cwd })
            sessions.open(id)
            close?.()
          })
          .catch((err) => toast(String(err.message || err), 'err'))
          .finally(() => setBusyId(null))
      }, [client, close])
      const runOpenRef = useRef(runOpen)
      runOpenRef.current = runOpen

      const selectableItems = items.filter((item) => !item.running)
      const selectedRows = items.filter((item) => selected[item.id] && !item.running)
      const selectedCount = selectedRows.length
      const selectedSize = selectedRows.reduce((n, item) => n + (item.sizeBytes || 0), 0)
      const allSelected = selectableItems.length > 0 && selectableItems.every((item) => selected[item.id])

      const toggleSelect = useCallback((id) => {
        setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
      }, [])

      const toggleSelectAll = useCallback(() => {
        setSelected((prev) => {
          const next = { ...prev }
          if (allSelected) {
            for (const item of selectableItems) delete next[item.id]
          } else {
            for (const item of selectableItems) next[item.id] = true
          }
          return next
        })
      }, [selectableItems, allSelected])

      const runDeleteOne = useCallback(async (item) => {
        const name = item.title || item.id
        const ok = await confirmDialog({
          title: '删除会话',
          desc: `将永久删除「<b>${esc(name.length > 40 ? `${name.slice(0, 40)}…` : name)}</b>」（${formatBytes(item.sizeBytes)}），此操作不可恢复。`,
        })
        if (!ok) return
        setBusyId(item.id)
        postJson(`${API}/delete`, { sessionIds: [item.id], confirmToken: 'DELETE' })
          .then((result) => toast(`已删除 ${result.deletedSessionIds.length} 个会话。`))
          .catch((err) => toast(String(err.message || err), 'err'))
          .finally(() => {
            setBusyId(null)
            setSelected((prev) => { const next = { ...prev }; delete next[item.id]; return next })
            load()
          })
      }, [load])

      const runBatchDelete = useCallback(async () => {
        if (selectedCount === 0) return
        const ok = await confirmDialog({
          title: '删除所选会话',
          desc: `将永久删除所选 <b>${selectedCount}</b> 个会话，共 <b>${formatBytes(selectedSize)}</b>，此操作不可恢复。`,
        })
        if (!ok) return
        const targetIds = selectedRows.map((item) => item.id)
        setBusyId('__batch__')
        postJson(`${API}/delete`, { sessionIds: targetIds, confirmToken: 'DELETE' })
          .then((result) => toast(`已删除 ${result.deletedSessionIds.length} 个会话，释放 ${formatBytes(selectedSize)}。`))
          .catch((err) => toast(String(err.message || err), 'err'))
          .finally(() => {
            setBusyId(null)
            setSelected({})
            load()
          })
      }, [selectedCount, selectedSize, selectedRows, load])

      const onRowClick = useCallback((e) => {
        const actEl = e.target.closest('[data-act]')
        const row = e.target.closest('tr[data-id]')
        if (!row) return
        const id = row.dataset.id
        const item = items.find((x) => x.id === id)
        if (!item) return
        const act = actEl ? actEl.dataset.act : null
        if (act === 'check') return // change 事件处理
        if (loading || busyId) return
        if (act === 'archive') { runArchiveRef.current(id, 'archive'); return }
        if (act === 'unarchive') { runArchiveRef.current(id, 'unarchive'); return }
        if (act === 'delete') { runDeleteOne(item); return }
        openPreview(item)
      }, [items, loading, busyId, runDeleteOne, openPreview])

      const table = h('div', {
        ref: tableRef,
        className: 'dshsm-tblwrap' + (loading ? ' dshsm-table-state-loading' : ''),
        'aria-busy': String(loading),
      },
        h('table', { className: 'dshsm-list dshsm-session-list' },
          h('thead', null,
            h('tr', null,
              h('th', { style: { width: 34 } }, h(SelectAllCheckbox, {
                checked: allSelected, mixed: selectedCount > 0 && !allSelected,
                disabled: loading || Boolean(busyId) || selectableItems.length === 0,
                onChange: toggleSelectAll, label: '全选当前会话',
              })),
              h('th', null, '标题'),
              h('th', null, '来源'),
              h('th', null, '状态'),
              h('th', null, '操作'))),
          h('tbody', { onClick: onRowClick },
            items.length === 0
              ? h('tr', null, h('td', { colSpan: 5 }, h('div', { style: { padding: '30px 0' } }),
                h(EmptyState, { title: '没有匹配的会话', sub: '调整筛选条件，或到「导入」页从 Claude Code / Codex 导入历史会话。' })))
              : items.map((item) => {
                const pills = item.running
                  ? [h('span', { className: 'dshsm-pill dshsm-run' }, '运行中')]
                  : [h('span', { className: item.archived ? 'dshsm-pill dshsm-arch' : 'dshsm-pill dshsm-ok' }, item.archived ? '已归档' : '活跃')]
                const busy = busyId === item.id
                const actions = item.running
                  ? [
                    h('span', { key: 'lock', className: 'dshsm-locknote' }, '运行中不可删除'),
                  ]
                  : [
                    h('button', {
                      key: 'arch', type: 'button', className: 'dshsm-btn', 'data-act': item.archived ? 'unarchive' : 'archive', disabled: loading || busy,
                    }, item.archived ? '取消归档' : '归档'),
                    h('button', { key: 'del', type: 'button', className: 'dshsm-btn dshsm-del', 'data-act': 'delete', disabled: loading || busy }, '删除'),
                  ]
                return h('tr', { key: item.id, 'data-id': item.id, className: 'dshsm-clickable' },
                  h('td', null, h('input', {
                    type: 'checkbox',
                    checked: Boolean(selected[item.id]),
                    onChange: () => toggleSelect(item.id),
                    disabled: loading || item.running,
                    'data-act': 'check',
                    'data-id': item.id,
                    'aria-label': `选择 ${item.title || item.id}`,
                  })),
                  h('td', { className: 'dshsm-cell-title' },
                    h('div', { className: 'dshsm-t' }, item.title || item.id)),
                  h('td', null, h(SourceChip, { source: item.source })),
                  h('td', null, pills.length ? pills : h('span', { style: { color: 'var(--dshsm-text-3)' } }, '—')),
                  h('td', null, h('div', { className: 'dshsm-rowbtns' }, actions)))
              }))),
        loading ? h('div', {
          ref: loadingRef,
          className: 'dshsm-table-loading',
          role: 'status',
          'aria-live': 'polite',
          hidden: true,
        },
          h('div', { className: 'dshsm-table-loading-inner' },
            h(Svg, { name: 'refresh', size: 17, className: 'dshsm-spin' }),
            h('span', null, '正在加载会话…'))) : null)

      return h('section', null,
        h('div', { className: 'dshsm-toolbar dshsm-session-toolbar' },
          h('label', { className: 'dshsm-field' },
            h(Svg, { name: 'search' }),
            h('input', { ref: searchRef, placeholder: '搜索标题/正文', 'aria-label': '搜索标题/正文', value: query, onChange: (e) => setQuery(e.target.value) })),
          h(Dropdown, { value: source, onChange: setSource, ariaLabel: '来源筛选', options: SOURCE_FILTER_OPTIONS, iconOnly: true, className: 'dshsm-session-source' }),
          h(Dropdown, { value: archived, onChange: setArchived, ariaLabel: '状态筛选', options: ARCHIVED_OPTIONS, className: 'dshsm-session-status' }),
          h(Dropdown, { value: workspace, onChange: setWorkspace, ariaLabel: '工作区筛选', options: workspaceOptions, iconOnly: true, className: 'dshsm-session-workspace' }),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', className: 'dshsm-btn dshsm-ghost dshsm-session-refresh', 'aria-label': '刷新会话', title: '刷新', disabled: loading, onClick: load }, h(Svg, { name: 'refresh', size: 15, className: loading ? 'dshsm-spin' : undefined }), '刷新')),
        query ? h('div', { className: 'dshsm-hint' }, '首次全文搜索会按需建立索引，可能需要稍候；配置 fullTextSearch: never 可回退标题搜索。') : null,
        selectedCount > 0 ? h('div', { className: 'dshsm-selbar' },
          h('span', { className: 'dshsm-selmeta' }, '已选 ', h('b', null, String(selectedCount)), ' 项 · 共 ', h('b', null, formatBytes(selectedSize))),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', className: 'dshsm-btn dshsm-ghost', onClick: () => setSelected({}) }, '取消选择'),
          h('button', {
            type: 'button',
            className: 'dshsm-btn dshsm-danger',
            onClick: runBatchDelete,
            disabled: busyId === '__batch__',
          }, h(Svg, { name: 'trash', size: 13 }), busyId === '__batch__' ? '删除中…' : '删除所选')) : null,
        error ? h('div', { className: 'dshsm-alert dshsm-error' },
          h(Svg, { name: 'warn', size: 15 }),
          h('span', null, String(error)),
          h('button', { type: 'button', className: 'dshsm-alert-act', onClick: load }, '重试')) : null,
        table)
    }

    /* ================= 导入 tab ================= */

    function ImportSection({ client }) {
      const [source, setSource] = useState('claude-code')
      const [workspace, setWorkspace] = useState('')
      const [picking, setPicking] = useState(false)
      const [candidates, setItems] = useState([])
      const items = workspace ? candidates.filter(item => workspacePath(item.cwd) === workspacePath(workspace)) : candidates
      const [selected, setSelected] = useState({})
      const [importedIds, setImportedIds] = useState({})
      const [report, setReport] = useState(null)
      const [scanning, setScanning] = useState(false)
      const [importing, setImporting] = useState(false)
      const [error, setError] = useState(null)
      const scannedRef = useRef(false)
      const scanSeq = useRef(0)

      const scan = useCallback((nextSource = source) => {
        const seq = ++scanSeq.current
        setScanning(true)
        setError(null)
        setReport(null)
        setSelected({})
        const params = new URLSearchParams()
        params.set('source', nextSource)
        fetchJson(`${API}/scan?${params.toString()}`)
          .then((result) => {
            if (seq !== scanSeq.current) return
            setItems(result.items || [])
            scannedRef.current = true
          })
          .catch((err) => {
            if (seq !== scanSeq.current) return
            setItems([])
            setError(String(err.message || err))
          })
          .finally(() => {
            if (seq === scanSeq.current) setScanning(false)
          })
      }, [source])

      useEffect(() => { scan() }, []) // 首扫；来源切换由 dropdown 回调显式重扫

      const changeSource = useCallback((src) => {
        if (src === source) return
        setSource(src)
        setItems([])
        setImportedIds({})
        scannedRef.current = false
        scan(src)
      }, [source, scan])

      const chooseWorkspace = useCallback(async () => {
        setPicking(true)
        try {
          const path = await client.get('workspaces').pickDirectory()
          if (path == null) return
          setWorkspace(path)
          setSelected({})
          setReport(null)
        } catch (err) { toast(String(err.message || err), 'err') }
        finally { setPicking(false) }
      }, [client])

      const toggle = useCallback((id) => {
        setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
      }, [])

      const selectableItems = items.filter(item => !importedIds[item.sourceSessionId])
      const allSelected = selectableItems.length > 0 && selectableItems.every(item => selected[item.sourceSessionId])
      const toggleAll = useCallback(() => {
        setSelected((prev) => {
          const next = { ...prev }
          if (allSelected) {
            for (const item of items) delete next[item.sourceSessionId]
          } else {
            for (const item of items) {
              if (!importedIds[item.sourceSessionId]) next[item.sourceSessionId] = true
            }
          }
          return next
        })
      }, [items, allSelected, importedIds])

      const selectedCount = items.filter((item) => selected[item.sourceSessionId] && !importedIds[item.sourceSessionId]).length

      const runImport = useCallback(() => {
        const targets = items
          .filter((item) => selected[item.sourceSessionId] && !importedIds[item.sourceSessionId])
          .map((item) => ({ sourceSessionId: item.sourceSessionId, path: item.path }))
        if (targets.length === 0) return
        setImporting(true)
        setError(null)
        postJson(`${API}/import`, { source, targets })
          .then((result) => {
            setReport(result)
            setImportedIds((prev) => {
              const next = { ...prev }
              for (const entry of result.items || []) {
                if (entry.status === 'success') next[entry.sourceSessionId] = true
              }
              return next
            })
            setSelected({})
            toast(`已导入 ${result.success} 个会话到对应工作区${result.failed ? `，失败 ${result.failed} 个，请查看导入结果。` : '，可在「会话」页查看；刷新页面后侧栏同步。'}`, result.failed ? 'err' : 'ok')
          })
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setImporting(false))
      }, [items, selected, importedIds, source])

      const emptyText = workspace ? '该工作区没有可导入的历史会话，可切换来源或清除工作区筛选。' : `没有可导入的 ${sourceLabels[source]} 历史会话。`

      const table = h('div', { className: 'dshsm-tblwrap' },
        h('table', { className: 'dshsm-list dshsm-compact' },
          h('thead', null,
            h('tr', null,
              h('th', { style: { width: 34 } }, h(SelectAllCheckbox, {
                checked: allSelected, mixed: selectedCount > 0 && !allSelected,
                disabled: scanning || importing || picking || selectableItems.length === 0,
                onChange: toggleAll, label: '全选当前可导入会话',
              })),
              h('th', null, '标题'),
              h('th', null, '最后活跃'),
              h('th', { className: 'dshsm-num' }, '大小'),
              h('th', null, '路径'))),
          h('tbody', null,
            items.length === 0
              ? h('tr', null, h('td', { colSpan: 5 }, h('div', { style: { padding: '30px 0' } }),
                h(EmptyState, { title: '没有可导入的会话', sub: emptyText })))
              : items.map((item) => {
                const imported = Boolean(importedIds[item.sourceSessionId])
                return h('tr', { key: item.sourceSessionId },
                  h('td', null, h('input', {
                    type: 'checkbox',
                    checked: Boolean(selected[item.sourceSessionId]) && !imported,
                    disabled: imported,
                    onChange: () => toggle(item.sourceSessionId),
                    'aria-label': `选择 ${item.title || item.sourceSessionId}`,
                  })),
                  h('td', { className: 'dshsm-cell-title' },
                    h('div', { className: 'dshsm-t' },
                      item.title || item.sourceSessionId,
                      imported ? h('span', { className: 'dshsm-pill dshsm-ok', style: { marginLeft: 6 } }, '已导入') : null,
                      item.badLines > 0 ? h('span', { className: 'dshsm-pill dshsm-fail', style: { marginLeft: 6 } }, `坏行 ${item.badLines}`) : null)),
                  h('td', { className: 'dshsm-dim', title: absTime(item.updatedAt) }, relTime(item.updatedAt)),
                  h('td', { className: 'dshsm-num' }, formatBytes(item.sizeBytes)),
                  h('td', { className: 'dshsm-cell-path', title: item.path }, item.path))
              }))))

      return h('section', null,
        h('div', { className: 'dshsm-toolbar' },
          h(Dropdown, { value: source, onChange: changeSource, ariaLabel: '选择导入来源', options: IMPORT_SOURCE_OPTIONS, iconOnly: true, disabled: importing || picking }),
          h('button', { type: 'button', className: 'dshsm-btn dshsm-ghost',
            'aria-label': '从项目工作区导入', 'aria-pressed': Boolean(workspace),
            title: workspace ? `工作区：${workspace}` : '选择项目工作区', disabled: picking || importing, onClick: chooseWorkspace,
          }, h(Svg, { name: 'folder', size: 16 }), '从项目工作区导入'),
          workspace ? h('button', { type: 'button', className: 'dshsm-btn dshsm-ghost dshsm-icon-btn',
            'aria-label': '清除工作区筛选', title: '全部工作区', disabled: importing || picking,
            onClick: () => { setWorkspace(''); setSelected({}); setReport(null) },
          }, h(Svg, { name: 'x', size: 14 })) : null,
          h('button', {
            type: 'button',
            className: 'dshsm-btn dshsm-ghost',
            onClick: () => scan(),
            disabled: scanning || importing,
          }, scanning ? h(Svg, { name: 'refresh', size: 13, className: 'dshsm-spin' }) : h(Svg, { name: 'search', size: 13 }), scanning ? '扫描中…' : '扫描'),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            className: 'dshsm-btn dshsm-primary',
            onClick: runImport,
            disabled: importing || scanning || picking || selectedCount === 0,
          }, h(Svg, { name: 'open', size: 13 }), importing ? '导入中…' : `导入所选（${selectedCount}）`)),
        error ? h('div', { className: 'dshsm-alert dshsm-error' },
          h(Svg, { name: 'warn', size: 15 }),
          h('span', null, String(error)),
          h('button', { type: 'button', className: 'dshsm-alert-act', onClick: () => scan() }, '重试')) : null,
        report ? h('div', { className: 'dshsm-report' },
          h('div', { className: 'dshsm-report-head' }, '导入报告',
            h('span', { className: 'dshsm-pill dshsm-ok' }, `成功 ${report.success}`),
            h('span', { className: 'dshsm-pill dshsm-arch' }, `跳过 ${report.skipped}`),
            report.failed ? h('span', { className: 'dshsm-pill dshsm-fail' }, `失败 ${report.failed}`) : null),
          h('ul', null, (report.items || []).map((entry, index) =>
            h('li', {
              key: `${entry.sourceSessionId}-${index}`,
              className: entry.status === 'failed' ? 'dshsm-fail' : undefined,
            },
              h('span', { className: 'dshsm-mono' }, entry.sourceSessionId),
              h('span', null, entry.status === 'success' ? '成功' : entry.status === 'skipped' ? '跳过' : '失败'),
              entry.dshSessionId ? h('span', { className: 'dshsm-arrow' }, '→') : null,
              entry.dshSessionId ? h('span', { className: 'dshsm-mono' }, entry.dshSessionId) : null,
              entry.reason ? h('span', { className: 'dshsm-reason' }, entry.reason) : null,
              entry.badLines ? h('span', { className: 'dshsm-reason' }, `坏行 ${entry.badLines}`) : null)))) : null,
        scanning && items.length === 0 ? h(Skeleton, { rows: 3 }) : table)
    }

    /* ================= 清理与统计 tab ================= */

    function ruleLabel(key, rules) {
      if (key === 'olderThanDays') return `早于 ${rules.olderThanDays} 天`
      if (key === 'largerThanMb') return `大于 ${rules.largerThanMb} MB`
      if (key === 'emptySessions') return '空会话'
      return key
    }

    function CleanupSection() {
      const [stats, setStats] = useState(null)
      const [olderThanDays, setOlderThanDays] = useState('30')
      const [largerThanMb, setLargerThanMb] = useState('100')
      const [emptySessions, setEmptySessions] = useState(false)
      const [archivedOnly, setArchivedOnly] = useState(true)
      const [source, setSource] = useState('all')
      const [preview, setPreview] = useState(null)
      const [selected, setSelected] = useState({})
      const [report, setReport] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)

      const loadStats = useCallback(() => {
        setError(null)
        fetchJson(`${API}/stats`)
          .then(setStats)
          .catch((err) => setError(String(err.message || err)))
      }, [])

      useEffect(() => { loadStats() }, [loadStats])

      const runPreview = useCallback(() => {
        const params = new URLSearchParams()
        if (olderThanDays !== '') params.set('olderThanDays', olderThanDays)
        if (largerThanMb !== '') params.set('largerThanMb', largerThanMb)
        params.set('emptySessions', emptySessions ? 'true' : 'false')
        params.set('archivedOnly', archivedOnly ? 'true' : 'false')
        if (source !== 'all') params.set('source', source)
        setLoading(true)
        setError(null)
        setReport(null)
        fetchJson(`${API}/cleanup/preview?${params.toString()}`)
          .then((value) => {
            setPreview(value)
            const next = {}
            for (const item of value.items || []) next[item.id] = true
            setSelected(next)
          })
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setLoading(false))
      }, [olderThanDays, largerThanMb, emptySessions, archivedOnly, source])

      const previewItems = preview ? preview.items || [] : []
      const selectedRows = previewItems.filter((item) => selected[item.id])
      const selectedCount = selectedRows.length
      const selectedSize = selectedRows.reduce((n, item) => n + (item.sizeBytes || 0), 0)

      const togglePreview = useCallback((id) => {
        setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
      }, [])

      const runExecute = useCallback(async () => {
        if (!preview || selectedCount === 0) return
        const ok = await confirmDialog({
          title: '执行清理',
          desc: `将永久删除所选 <b>${selectedCount}</b> 个会话，共 <b>${formatBytes(selectedSize)}</b>，此操作不可恢复。`,
        })
        if (!ok) return
        const ids = selectedRows.map((item) => item.id)
        setLoading(true)
        setError(null)
        postJson(`${API}/cleanup/execute`, {
          previewId: preview.previewId,
          sessionIds: ids,
          confirmToken: 'DELETE',
        })
          .then((value) => {
            setReport(value)
            setPreview(null)
            setSelected({})
            toast(`已清理 ${value.success} 个会话，释放 ${formatBytes(selectedSize)}。`)
            loadStats()
          })
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setLoading(false))
      }, [preview, selectedCount, selectedSize, selectedRows, loadStats])

      const total = stats ? stats.totalSessions : 0
      const archivedCount = stats ? (stats.sessions || []).filter((s) => s.archived).length : 0
      const runningCount = stats ? (stats.sessions || []).filter((s) => s.running).length : 0
      const barColors = { dsh: 'var(--dshsm-src-dsh)', 'claude-code': 'var(--dshsm-src-claude)', codex: 'var(--dshsm-src-openai)' }
      const bySource = stats ? (stats.bySource || []).filter((e) => e.count > 0) : []
      const totalSize = stats ? stats.totalSizeBytes : 0

      const reportCard = report ? h('div', { className: 'dshsm-report' },
        h('div', { className: 'dshsm-report-head' }, '清理报告',
          h('span', { className: 'dshsm-pill dshsm-ok' }, `成功 ${report.success}`),
          report.failed ? h('span', { className: 'dshsm-pill dshsm-fail' }, `失败 ${report.failed}`) : null),
        h('ul', null, (report.items || []).map((entry, index) =>
          h('li', {
            key: `${entry.sessionId}-${index}`,
            className: entry.status === 'failed' ? 'dshsm-fail' : undefined,
          },
            h('span', { className: 'dshsm-mono' }, entry.sessionId),
            entry.path ? h('span', { className: 'dshsm-reason dshsm-mono' }, entry.path) : null,
            entry.reason ? h('span', { className: 'dshsm-reason' }, entry.reason) : null)))) : null

      const previewBox = preview ? h('div', { className: 'dshsm-preview' },
        h('div', { className: 'dshsm-preview-head' },
          h('span', { className: 'dshsm-sum' }, `匹配 ${preview.total} 个会话`, h('span', { className: 'dshsm-light' }, ` · 可释放 ${formatBytes(preview.totalSizeBytes)}`)),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            className: 'dshsm-btn dshsm-danger',
            onClick: runExecute,
            disabled: selectedCount === 0 || loading,
          }, h(Svg, { name: 'trash', size: 13 }), loading ? '清理中…' : `清理所选（${selectedCount} · ${formatBytes(selectedSize)}）`)),
        (preview.excluded || []).length > 0 ? h('div', { className: 'dshsm-preview-excluded' },
          `已自动排除运行中会话：${preview.excluded.map((e) => e.title || e.sessionId).join('、')}`) : null,
        h('div', { className: 'dshsm-tblwrap', style: { border: 'none', borderRadius: 0 } },
          h('table', { className: 'dshsm-list' },
            h('thead', null,
              h('tr', null,
                h('th', { style: { width: 34 } }),
                h('th', null, '标题'),
                h('th', null, '来源'),
                h('th', null, '最后活跃'),
                h('th', { className: 'dshsm-num' }, '大小'),
                h('th', null, '匹配规则'))),
            h('tbody', null,
              previewItems.length === 0
                ? h('tr', null, h('td', { colSpan: 6, style: { padding: '30px 0' } }, h(EmptyState, { title: '没有候选会话', sub: '调整清理规则后重新生成预览。' })))
                : previewItems.map((item) =>
                  h('tr', { key: item.id },
                    h('td', null, h('input', {
                      type: 'checkbox',
                      checked: Boolean(selected[item.id]),
                      onChange: () => togglePreview(item.id),
                      'aria-label': `选择 ${item.title || item.id}`,
                    })),
                    h('td', { className: 'dshsm-cell-title' }, h('div', { className: 'dshsm-t' }, item.title || item.id)),
                    h('td', null, h(SourceChip, { source: item.source })),
                    h('td', { className: 'dshsm-dim', title: absTime(item.updatedAt) }, relTime(item.updatedAt)),
                    h('td', { className: 'dshsm-num' }, formatBytes(item.sizeBytes)),
                    h('td', null, (item.matchedRules || []).map((r) =>
                      h('span', { key: r, className: 'dshsm-rulechip' }, ruleLabel(r, preview.rules || {}))))))))))
        : null

      return h('section', { className: 'dshsm-cleanwrap' },
        h('h3', { className: 'dshsm-sect' }, '全局统计'),
        error ? h('div', { className: 'dshsm-alert dshsm-error' },
          h(Svg, { name: 'warn', size: 15 }),
          h('span', null, String(error)),
          h('button', { type: 'button', className: 'dshsm-alert-act', onClick: loadStats }, '重试')) : null,
        stats ? h('div', null,
          h('div', { className: 'dshsm-tiles' },
            h('div', { className: 'dshsm-tile' }, h('div', { className: 'dshsm-tile-label' }, '会话总数'), h('div', { className: 'dshsm-tile-value' }, String(total)), h('div', { className: 'dshsm-tile-sub' }, '所有来源')),
            h('div', { className: 'dshsm-tile' }, h('div', { className: 'dshsm-tile-label' }, '总日志大小'), h('div', { className: 'dshsm-tile-value' }, formatBytes(totalSize)), h('div', { className: 'dshsm-tile-sub' }, 'JSONL 会话日志')),
            h('div', { className: 'dshsm-tile' }, h('div', { className: 'dshsm-tile-label' }, '已归档'), h('div', { className: 'dshsm-tile-value' }, String(archivedCount)), h('div', { className: 'dshsm-tile-sub' }, '可在清理中回收')),
            h('div', { className: 'dshsm-tile' }, h('div', { className: 'dshsm-tile-label' }, '运行中'), h('div', { className: 'dshsm-tile-value' }, String(runningCount)), h('div', { className: 'dshsm-tile-sub' }, '受保护，不可删除'))),
          bySource.length > 0 ? h('div', { className: 'dshsm-storebar' },
            h('div', { className: 'dshsm-bar' }, bySource.map((e) =>
              h('span', {
                key: e.source,
                style: { flex: Math.max(e.totalSizeBytes, 1), background: barColors[e.source] || 'var(--dshsm-text-3)' },
                title: `${sourceLabels[e.source] || e.source} ${formatBytes(e.totalSizeBytes)}`,
              }))),
            h('div', { className: 'dshsm-legend' }, bySource.map((e) =>
              h('div', { key: e.source, className: 'dshsm-li' },
                h('span', { className: 'dshsm-swatch', style: { background: barColors[e.source] || 'var(--dshsm-text-3)' } }),
                sourceLabels[e.source] || e.source,
                h('span', { className: 'dshsm-n' }, `${e.count} 个会话`),
                h('span', { className: 'dshsm-v' }, `${formatBytes(e.totalSizeBytes)} · ${totalSize ? Math.round((e.totalSizeBytes / totalSize) * 100) : 0}%`)))))
          : null,
          h('details', { className: 'dshsm-metrics' },
            h('summary', null, h(Svg, { name: 'chev', size: 13 }), '每会话指标'),
            h('div', { className: 'dshsm-metrics-inner' },
              h('div', { className: 'dshsm-tblwrap', style: { border: 'none', borderRadius: 0 } },
                h('table', { className: 'dshsm-list dshsm-compact' },
                  h('thead', null,
                    h('tr', null,
                      h('th', null, '标题'),
                      h('th', null, '来源'),
                      h('th', { className: 'dshsm-num' }, '大小'),
                      h('th', { className: 'dshsm-num' }, '消息'),
                      h('th', { className: 'dshsm-num' }, '时长'),
                      h('th', { className: 'dshsm-num' }, '工具调用（成功/无结果）'))),
                  h('tbody', null, (stats.sessions || []).map((s) =>
                    h('tr', { key: s.id },
                      h('td', { className: 'dshsm-cell-title', style: { maxWidth: 240, minWidth: 120 } }, h('div', { className: 'dshsm-t' }, s.title || s.id)),
                      h('td', null, h(SourceChip, { source: s.source })),
                      h('td', { className: 'dshsm-num' }, formatBytes(s.sizeBytes)),
                      h('td', { className: 'dshsm-num' }, String(s.messageCount)),
                      h('td', { className: 'dshsm-num' }, formatDuration(s.durationMs)),
                      h('td', { className: 'dshsm-num' }, `${s.toolCalls}（${s.toolSuccess}/${s.toolNoResult}）`)))))))))
        : h(Skeleton, { rows: 3 }),
        h('h3', { className: 'dshsm-sect' }, '批量清理规则'),
        h('div', { className: 'dshsm-rules' },
          h('label', { className: 'dshsm-rulefield' }, '早于 ',
            h('input', { type: 'number', min: 0, value: olderThanDays, onChange: (e) => setOlderThanDays(e.target.value) }), ' 天'),
          h('label', { className: 'dshsm-rulefield' }, '大于 ',
            h('input', { type: 'number', min: 0, value: largerThanMb, onChange: (e) => setLargerThanMb(e.target.value) }), ' MB'),
          h('label', { className: 'dshsm-check' },
            h('input', { type: 'checkbox', checked: emptySessions, onChange: (e) => setEmptySessions(e.target.checked) }), '空会话'),
          h('label', { className: 'dshsm-check' },
            h('input', { type: 'checkbox', checked: archivedOnly, onChange: (e) => setArchivedOnly(e.target.checked) }), '仅已归档'),
          h(Dropdown, { value: source, onChange: setSource, ariaLabel: '清理来源筛选', options: SOURCE_FILTER_OPTIONS }),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', className: 'dshsm-btn dshsm-primary', onClick: runPreview, disabled: loading }, h(Svg, { name: 'search', size: 13 }), loading ? '生成中…' : '生成预览')),
        previewBox,
        reportCard)
    }

    /* ================= 区块入口 ================= */

    function SessionManagementSection({ client, close }) {
      const [tab, setTab] = useState('sessions')
      const [sessionCount, setSessionCount] = useState(null)
      const onTotal = useCallback((count) => setSessionCount(count), [])
      return h('div', { className: 'dshsm' },
        h('div', { className: 'dshsm-head' },
          h('h2', null, '会话管理')),
        h('nav', { className: 'dshsm-tabs', role: 'tablist' },
          h('button', {
            type: 'button',
            className: 'dshsm-tab',
            role: 'tab',
            'aria-selected': String(tab === 'sessions'),
            onClick: () => setTab('sessions'),
          }, '会话', sessionCount != null ? h('span', { className: 'dshsm-count' }, String(sessionCount)) : null),
          h('button', {
            type: 'button',
            className: 'dshsm-tab',
            role: 'tab',
            'aria-selected': String(tab === 'import'),
            onClick: () => setTab('import'),
          }, '导入'),
          h('button', {
            type: 'button',
            className: 'dshsm-tab',
            role: 'tab',
            'aria-selected': String(tab === 'cleanup'),
            onClick: () => setTab('cleanup'),
          }, '清理与统计')),
        tab === 'sessions' ? h(SessionsSection, { onTotal, client, close })
          : tab === 'import' ? h(ImportSection, { client })
            : h(CleanupSection))
    }

    const inject = ['slots']

    function apply(ctx) {
      ensureClientChrome()
      ctx.effect(() => ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section',
          id: 'session-management',
          order: 100,
          label: () => '会话管理',
        }, (props) => h(SessionManagementSection, { ...props, client: ctx })),
      ), '@dsh-external/dsh-session-management: settings section')
    }

    return { inject, apply }
  },
})
}
