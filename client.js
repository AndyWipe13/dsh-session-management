/**
 * Client half for @dsh-external/dsh-session-management.
 *
 * Registers the "会话管理" settings section with a "会话" tab and renders a
 * thin adapter over the host SessionManagement HTTP API.  All read/business
 * logic lives in the host service; this file only renders results and calls
 * `/@dsh-external/dsh-session-management/api`.
 *
 * This bundle is loaded through DSH's client ModuleLoader, so it is written
 * as a factory script (CJS-style) rather than an ESM module.
 */
/* global window */
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-session-management',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React

    const API = '/@dsh-external/dsh-session-management/api'

    function fetchJson(url) {
      return fetch(url).then((res) => {
        if (!res.ok) {
          return res.json().then((body) => {
            throw new Error((body && body.error) || `HTTP ${res.status}`)
          })
        }
        return res.json()
      })
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B'
      const mb = bytes / 1024 / 1024
      return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
    }

    function formatDate(value) {
      if (!value) return '—'
      return new Date(value).toLocaleString()
    }

    const sourceLabels = {
      dsh: 'DSH',
      'claude-code': 'Claude Code',
      codex: 'Codex',
    }

    function sourceLabel(value) {
      return sourceLabels[value] || value
    }

    function SessionsSection() {
      const [query, setQuery] = useState('')
      const [source, setSource] = useState('all')
      const [archived, setArchived] = useState('all')
      const [workspace, setWorkspace] = useState('')
      const [items, setItems] = useState([])
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)

      const load = useCallback(() => {
        const params = new URLSearchParams()
        if (query) params.set('query', query)
        if (source !== 'all') params.set('source', source)
        if (archived !== 'all') params.set('archived', archived)
        if (workspace) params.set('workspace', workspace)
        setLoading(true)
        setError(null)
        fetchJson(`${API}/list?${params.toString()}`)
          .then((result) => setItems(result.items || []))
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setLoading(false))
      }, [query, source, archived, workspace])

      useEffect(() => {
        load()
      }, [load])

      const openPreview = useCallback((id) => {
        setLoading(true)
        setError(null)
        fetchJson(`${API}/preview?id=${encodeURIComponent(id)}`)
          .then(setPreview)
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setLoading(false))
      }, [])

      const sourceOptions = ['all', 'dsh', 'claude-code', 'codex']
      const archivedOptions = [['all', '全部'], ['false', '活跃'], ['true', '已归档']]

      return React.createElement('div', { style: { padding: '12px', fontFamily: 'sans-serif' } },
        React.createElement('h2', null, '会话管理'),
        React.createElement('div', { style: { display: 'flex', gap: '4px', marginBottom: '8px', borderBottom: '1px solid #ccc' } },
          React.createElement('button', {
            style: { padding: '4px 12px', fontWeight: 'bold', border: '1px solid #ccc', borderBottom: 'none', background: '#fff', cursor: 'default' },
          }, '会话'),
          React.createElement('span', { style: { padding: '4px 12px', color: '#888' } }, '导入（后续切片）'),
          React.createElement('span', { style: { padding: '4px 12px', color: '#888' } }, '清理与统计（后续切片）'),
        ),
        React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
          React.createElement('input', {
            placeholder: '搜索标题…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            style: { padding: '4px' },
          }),
          React.createElement('select', {
            value: source,
            onChange: (event) => setSource(event.target.value),
            'aria-label': '来源筛选',
          }, sourceOptions.map((value) =>
            React.createElement('option', { key: value, value }, value === 'all' ? '全部来源' : value))),
          React.createElement('select', {
            value: archived,
            onChange: (event) => setArchived(event.target.value),
            'aria-label': '归档态筛选',
          }, archivedOptions.map(([value, label]) =>
            React.createElement('option', { key: value, value }, label))),
          React.createElement('input', {
            placeholder: '工作区筛选…',
            value: workspace,
            onChange: (event) => setWorkspace(event.target.value),
            style: { padding: '4px' },
          }),
          React.createElement('button', { onClick: load }, '刷新'),
        ),
        error ? React.createElement('div', { style: { color: 'red', marginBottom: '8px' } }, String(error)) : null,
        loading && !preview ? React.createElement('div', null, '加载中…') : null,
        React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%' } },
          React.createElement('thead', null,
            React.createElement('tr', null,
              ['标题', '来源', '最后活跃', '大小', '消息数', '状态'].map((label) =>
                React.createElement('th', { key: label, style: { border: '1px solid #ccc', padding: '4px', textAlign: 'left' } }, label)))),
          React.createElement('tbody', null,
            items.length === 0
              ? React.createElement('tr', null, React.createElement('td', { colSpan: 6, style: { padding: '8px' } }, '没有会话'))
              : items.map((item) =>
                React.createElement('tr', {
                  key: item.id,
                  onClick: () => openPreview(item.id),
                  style: { cursor: 'pointer', border: '1px solid #ccc' },
                },
                  React.createElement('td', { style: { padding: '4px' } }, item.title || item.id),
                  React.createElement('td', { style: { padding: '4px' } }, sourceLabel(item.source)),
                  React.createElement('td', { style: { padding: '4px' } }, formatDate(item.updatedAt)),
                  React.createElement('td', { style: { padding: '4px' } }, formatBytes(item.sizeBytes)),
                  React.createElement('td', { style: { padding: '4px' } }, String(item.messageCount)),
                  React.createElement('td', { style: { padding: '4px' } },
                    [item.running ? '运行中' : '', item.archived ? '已归档' : ''].filter(Boolean).join(', ') || '—'),
                )))),
        preview ? React.createElement('div', { style: { marginTop: '12px', borderTop: '1px solid #ccc', paddingTop: '8px' } },
          React.createElement('h3', null, `预览：${preview.title || preview.id}`),
          React.createElement('button', { onClick: () => setPreview(null) }, '关闭预览'),
          React.createElement('div', { style: { marginTop: '8px', whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '12px' } },
            (preview.events || []).map((event, index) =>
              React.createElement('div', { key: index }, `[${event.type || 'event'}] ${JSON.stringify(event.data || '')}`))),
        ) : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section',
          id: 'session-management',
          order: 100,
          label: () => '会话管理',
        }, SessionsSection),
      ), '@dsh-external/dsh-session-management: settings section')
    }

    return { inject, apply }
  },
})
}