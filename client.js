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
      const [notice, setNotice] = useState(null)
      const [busyId, setBusyId] = useState(null)
      const [loading, setLoading] = useState(false)
      const [selected, setSelected] = useState({})
      const [deleteToken, setDeleteToken] = useState('')

      const load = useCallback(() => {
        const params = new URLSearchParams()
        if (query) params.set('query', query)
        if (source !== 'all') params.set('source', source)
        if (archived !== 'all') params.set('archived', archived)
        if (workspace) params.set('workspace', workspace)
        const endpoint = query ? '/search' : '/list'
        setLoading(true)
        setError(null)
        fetchJson(`${API}${endpoint}?${params.toString()}`)
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

      const runArchiveAction = useCallback((id, action) => {
        setBusyId(id)
        setError(null)
        setNotice(null)
        postJson(`${API}/${action}`, { sessionId: id })
          .then(() => {
            setNotice(action === 'unarchive'
              ? '已取消归档，本列表已更新；内置侧栏将在页面刷新后收敛。'
              : '已归档，本列表已更新。')
            load()
          })
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setBusyId(null))
      }, [load])

      const runOpen = useCallback((item) => {
        setBusyId(item.id)
        setError(null)
        setNotice(null)
        postJson(`${API}/open`, { sessionId: item.id })
          .then((result) => {
            setNotice(result.alreadyRunning
              ? '该会话已在运行中。'
              : '已打开会话，可继续对话。')
            if (!result.alreadyRunning) load()
          })
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setBusyId(null))
      }, [load])

      const selectableItems = items.filter((item) => !item.running)

      const toggleSelect = useCallback((id) => {
        setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
      }, [])

      const toggleSelectAll = useCallback(() => {
        const allSelected = selectableItems.length > 0 && selectableItems.every((item) => selected[item.id])
        const next = {}
        if (!allSelected) {
          for (const item of selectableItems) next[item.id] = true
        }
        setSelected(next)
      }, [selectableItems, selected])

      const runDelete = useCallback((item) => {
        if (item.running) {
          setError('运行中会话不可删除。')
          return
        }
        setBusyId(item.id)
        setError(null)
        setNotice(null)
        const confirmed = window.confirm(`删除会话“${item.title || item.id}”（${formatBytes(item.sizeBytes)}）？此操作不可恢复。`)
        if (!confirmed) {
          setBusyId(null)
          return
        }
        postJson(`${API}/delete`, { sessionIds: [item.id], confirmToken: 'DELETE' })
          .then((result) => {
            setNotice(`已删除 ${result.deletedSessionIds.length} 个会话。`)
            setSelected((prev) => {
              const next = { ...prev }
              delete next[item.id]
              return next
            })
            load()
          })
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setBusyId(null))
      }, [load])

      const runBatchDelete = useCallback(() => {
        const targetIds = items
          .filter((item) => selected[item.id] && !item.running)
          .map((item) => item.id)
        if (targetIds.length === 0) return
        if (deleteToken !== 'DELETE') {
          setError('批量删除必须键入 DELETE 才能执行。')
          return
        }
        setBusyId('__batch__')
        setError(null)
        setNotice(null)
        postJson(`${API}/delete`, { sessionIds: targetIds, confirmToken: deleteToken })
          .then((result) => {
            setNotice(`已删除 ${result.deletedSessionIds.length} 个会话。`)
            setSelected({})
            setDeleteToken('')
            load()
          })
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setBusyId(null))
      }, [items, selected, deleteToken, load])

      const sourceOptions = ['all', 'dsh', 'claude-code', 'codex']
      const archivedOptions = [['all', '全部'], ['false', '活跃'], ['true', '已归档']]
      const selectedCount = selectableItems.filter((item) => selected[item.id]).length
      const allSelected = selectableItems.length > 0 && selectableItems.every((item) => selected[item.id])

      return React.createElement('div', { style: { padding: '12px', fontFamily: 'sans-serif' } },
        React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
          React.createElement('input', {
            placeholder: '搜索标题/正文…',
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
          React.createElement('button', {
            onClick: toggleSelectAll,
            disabled: selectableItems.length === 0,
          }, allSelected ? '取消全选' : '全选'),
          React.createElement('input', {
            placeholder: '批量删除需键入 DELETE',
            value: deleteToken,
            onChange: (event) => setDeleteToken(event.target.value),
            style: { padding: '4px', width: '180px' },
            'aria-label': '批量删除确认令牌',
          }),
          React.createElement('button', {
            onClick: runBatchDelete,
            disabled: selectedCount === 0 || busyId === '__batch__',
            style: { fontWeight: 'bold' },
          }, busyId === '__batch__' ? '删除中…' : `删除所选（${selectedCount}）`),
        ),
        error ? React.createElement('div', { style: { color: 'red', marginBottom: '8px' } }, String(error)) : null,
        notice ? React.createElement('div', { style: { color: '#1a7f37', marginBottom: '8px' } }, notice) : null,
        query ? React.createElement('div', { style: { color: '#777', marginBottom: '8px', fontSize: '12px' } }, '首次全文搜索会按需建立索引，可能需要稍候；配置 fullTextSearch: never 可回退标题搜索。') : null,
        loading && !preview ? React.createElement('div', null, '加载中…') : null,
        React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%' } },
          React.createElement('thead', null,
            React.createElement('tr', null,
              ['', '标题', '来源', '最后活跃', '大小', '消息数', '时长', '状态', '操作'].map((label, index) =>
                React.createElement('th', { key: label, style: { border: '1px solid #ccc', padding: '4px', textAlign: 'left' } }, label)))),
          React.createElement('tbody', null,
            items.length === 0
              ? React.createElement('tr', null, React.createElement('td', { colSpan: 9, style: { padding: '8px' } }, '没有会话'))
              : items.map((item) =>
                React.createElement('tr', {
                  key: item.id,
                  onClick: () => openPreview(item.id),
                  style: { cursor: 'pointer', border: '1px solid #ccc' },
                },
                  React.createElement('td', { style: { padding: '4px' } },
                    React.createElement('input', {
                      type: 'checkbox',
                      checked: Boolean(selected[item.id]),
                      disabled: item.running,
                      onChange: (event) => {
                        event.stopPropagation()
                        toggleSelect(item.id)
                      },
                      'aria-label': `选择 ${item.title || item.id}`,
                    })),
                  React.createElement('td', { style: { padding: '4px' } },
                    item.title || item.id,
                    item.snippet ? React.createElement('div', { style: { fontSize: '12px', color: '#555', whiteSpace: 'pre-wrap' } }, item.snippet) : null),
                  React.createElement('td', { style: { padding: '4px' } }, sourceLabel(item.source)),
                  React.createElement('td', { style: { padding: '4px' } }, formatDate(item.updatedAt)),
                  React.createElement('td', { style: { padding: '4px' } }, formatBytes(item.sizeBytes)),
                  React.createElement('td', { style: { padding: '4px' } }, String(item.messageCount)),
                  React.createElement('td', { style: { padding: '4px' } }, formatDuration(item.durationMs)),
                  React.createElement('td', { style: { padding: '4px' } },
                    [item.running ? '运行中' : '', item.archived ? '已归档' : ''].filter(Boolean).join(', ') || '—'),
                  React.createElement('td', { style: { padding: '4px' } },
                    React.createElement('button', {
                      onClick: (event) => {
                        event.stopPropagation()
                        runOpen(item)
                      },
                      disabled: busyId === item.id,
                      style: { padding: '2px 8px', marginRight: '4px' },
                    }, busyId === item.id ? '处理中…' : item.running ? '切换' : '打开/续聊'),
                    item.archived
                      ? React.createElement('button', {
                          onClick: (event) => {
                            event.stopPropagation()
                            runArchiveAction(item.id, 'unarchive')
                          },
                          disabled: busyId === item.id,
                          style: { padding: '2px 8px', marginRight: '4px' },
                        }, busyId === item.id ? '处理中…' : '取消归档')
                      : React.createElement('button', {
                          onClick: (event) => {
                            event.stopPropagation()
                            runArchiveAction(item.id, 'archive')
                          },
                          disabled: busyId === item.id,
                          style: { padding: '2px 8px', marginRight: '4px' },
                        }, busyId === item.id ? '处理中…' : '归档'),
                    item.running
                      ? React.createElement('span', { style: { color: '#b00', fontSize: '12px' } }, '运行中拒删')
                      : React.createElement('button', {
                          onClick: (event) => {
                            event.stopPropagation()
                            runDelete(item)
                          },
                          disabled: busyId === item.id,
                          style: { padding: '2px 8px', borderColor: '#b00', color: '#b00' },
                        }, busyId === item.id ? '处理中…' : '删除')),
                )))),
        React.createElement('div', { style: { marginTop: '4px', color: '#777', fontSize: '12px' } }, '取消归档经内部通道：本列表即时更新，内置侧栏在刷新后收敛。'),
        preview ? React.createElement('div', { style: { marginTop: '12px', borderTop: '1px solid #ccc', paddingTop: '8px' } },
          React.createElement('h3', null, `预览：${preview.title || preview.id}`),
          React.createElement('button', { onClick: () => setPreview(null) }, '关闭预览'),
          React.createElement('div', { style: { marginTop: '8px', whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '12px' } },
            (preview.events || []).map((event, index) =>
              React.createElement('div', { key: index }, `[${event.type || 'event'}] ${JSON.stringify(event.data || '')}`))),
        ) : null,
      )
    }

    function ImportSection() {
      const [source, setSource] = useState('claude-code')
      const [root, setRoot] = useState('')
      const [items, setItems] = useState([])
      const [selected, setSelected] = useState({})
      const [report, setReport] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)

      const load = useCallback(() => {
        setLoading(true)
        setError(null)
        setReport(null)
        const params = new URLSearchParams()
        params.set('source', source)
        if (root) params.set('root', root)
        fetchJson(`${API}/scan?${params.toString()}`)
          .then((result) => {
            setItems(result.items || [])
            setSelected({})
          })
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setLoading(false))
      }, [source, root])

      useEffect(() => {
        load()
      }, [load])

      const toggle = useCallback((id) => {
        setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
      }, [])

      const toggleAll = useCallback(() => {
        const allSelected = items.length > 0 && items.every((item) => selected[item.sourceSessionId])
        const next = {}
        if (!allSelected) {
          for (const item of items) next[item.sourceSessionId] = true
        }
        setSelected(next)
      }, [items, selected])

      const runImport = useCallback(() => {
        const targets = items
          .filter((item) => selected[item.sourceSessionId])
          .map((item) => ({ sourceSessionId: item.sourceSessionId, path: item.path }))
        if (targets.length === 0) return
        setLoading(true)
        setError(null)
        setReport(null)
        postJson(`${API}/import`, { source, targets, root: root || undefined })
          .then(setReport)
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setLoading(false))
      }, [source, items, selected, root])

      const selectedCount = items.filter((item) => selected[item.sourceSessionId]).length
      const allSelected = items.length > 0 && items.every((item) => selected[item.sourceSessionId])
      const rootPlaceholder = source === 'codex' ? 'Codex 目录（留空 = 默认 ~/.codex）' : 'Claude 项目目录（留空 = 默认）'
      const emptyText = source === 'codex' ? '没有可导入的 Codex 会话' : '没有可导入的 Claude Code 会话'

      return React.createElement('div', { style: { padding: '12px', fontFamily: 'sans-serif' } },
        React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px', alignItems: 'center' } },
          React.createElement('select', {
            value: source,
            onChange: (event) => setSource(event.target.value),
            style: { padding: '4px' },
          },
            React.createElement('option', { value: 'claude-code' }, 'Claude Code'),
            React.createElement('option', { value: 'codex' }, 'Codex'),
          ),
          React.createElement('input', {
            placeholder: rootPlaceholder,
            value: root,
            onChange: (event) => setRoot(event.target.value),
            style: { padding: '4px', minWidth: '260px' },
          }),
          React.createElement('button', { onClick: load, disabled: loading }, '扫描'),
          React.createElement('button', { onClick: toggleAll, disabled: items.length === 0 }, allSelected ? '取消全选' : '全选'),
          React.createElement('button', {
            onClick: runImport,
            disabled: loading || selectedCount === 0,
            style: { fontWeight: 'bold' },
          }, `导入所选（${selectedCount}）`),
        ),
        error ? React.createElement('div', { style: { color: 'red', marginBottom: '8px' } }, String(error)) : null,
        report ? React.createElement('div', { style: { marginBottom: '8px', padding: '8px', border: '1px solid #ccc', background: '#f9f9f9' } },
          React.createElement('h3', { style: { marginTop: 0 } }, `导入报告：成功 ${report.success} / 跳过 ${report.skipped} / 失败 ${report.failed}`),
          React.createElement('ul', { style: { margin: 0, paddingLeft: '20px' } },
            (report.items || []).map((item, index) =>
              React.createElement('li', { key: `${item.sourceSessionId}-${index}` },
                `${item.sourceSessionId} — ${item.status}${item.dshSessionId ? ` → ${item.dshSessionId}` : ''}${item.reason ? `：${item.reason}` : ''}${item.badLines ? `（坏行 ${item.badLines}）` : ''}`))),
        ) : null,
        loading && items.length === 0 ? React.createElement('div', null, '扫描中…') : null,
        React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%' } },
          React.createElement('thead', null,
            React.createElement('tr', null,
              ['', '标题', '来源', '最后活跃', '大小', '路径'].map((label, index) =>
                React.createElement('th', { key: index, style: { border: '1px solid #ccc', padding: '4px', textAlign: 'left' } }, label)))),
          React.createElement('tbody', null,
            items.length === 0
              ? React.createElement('tr', null, React.createElement('td', { colSpan: 6, style: { padding: '8px' } }, emptyText))
              : items.map((item) =>
                React.createElement('tr', { key: item.sourceSessionId, style: { border: '1px solid #ccc' } },
                  React.createElement('td', { style: { padding: '4px' } },
                    React.createElement('input', {
                      type: 'checkbox',
                      checked: Boolean(selected[item.sourceSessionId]),
                      onChange: () => toggle(item.sourceSessionId),
                      'aria-label': `选择 ${item.title || item.sourceSessionId}`,
                    })),
                  React.createElement('td', { style: { padding: '4px' } }, item.title || item.sourceSessionId),
                  React.createElement('td', { style: { padding: '4px' } }, sourceLabel(item.source)),
                  React.createElement('td', { style: { padding: '4px' } }, formatDate(item.updatedAt)),
                  React.createElement('td', { style: { padding: '4px' } }, formatBytes(item.sizeBytes)),
                  React.createElement('td', { style: { padding: '4px', fontSize: '12px', wordBreak: 'break-all' } }, item.path),
                )))),
      )
    }

    function formatDuration(ms) {
      if (ms == null) return '—'
      if (ms < 1000) return `${ms}ms`
      const seconds = ms / 1000
      if (seconds < 60) return `${seconds.toFixed(1)}s`
      const minutes = seconds / 60
      if (minutes < 60) return `${minutes.toFixed(1)}m`
      return `${(minutes / 60).toFixed(1)}h`
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
      const [deleteToken, setDeleteToken] = useState('')
      const [report, setReport] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)

      const loadStats = useCallback(() => {
        setLoading(true)
        setError(null)
        fetchJson(`${API}/stats`)
          .then(setStats)
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setLoading(false))
      }, [])

      useEffect(() => {
        loadStats()
      }, [loadStats])

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
            setDeleteToken('')
          })
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setLoading(false))
      }, [olderThanDays, largerThanMb, emptySessions, archivedOnly, source])

      const toggle = useCallback((id) => {
        setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
      }, [])

      const previewItems = preview ? preview.items || [] : []
      const selectedCount = previewItems.filter((item) => selected[item.id]).length

      const runExecute = useCallback(() => {
        if (!preview || selectedCount === 0) return
        if (deleteToken !== 'DELETE') {
          setError('清理必须键入 DELETE 才能执行。')
          return
        }
        const ids = previewItems.filter((item) => selected[item.id]).map((item) => item.id)
        setLoading(true)
        setError(null)
        setReport(null)
        postJson(`${API}/cleanup/execute`, {
          previewId: preview.previewId,
          sessionIds: ids,
          confirmToken: deleteToken,
        })
          .then((value) => {
            setReport(value)
            setPreview(null)
            setSelected({})
            setDeleteToken('')
            loadStats()
          })
          .catch((err) => setError(String(err.message || err)))
          .finally(() => setLoading(false))
      }, [preview, previewItems, selected, selectedCount, deleteToken, loadStats])

      const sourceOptions = ['all', 'dsh', 'claude-code', 'codex']

      return React.createElement('div', { style: { padding: '12px', fontFamily: 'sans-serif' } },
        React.createElement('h3', { style: { marginTop: 0 } }, '全局统计'),
        stats ? React.createElement('div', { style: { marginBottom: '12px' } },
          React.createElement('div', { style: { display: 'flex', gap: '24px', flexWrap: 'wrap', marginBottom: '8px' } },
            React.createElement('div', null, `会话总数：${stats.totalSessions}`),
            React.createElement('div', null, `总日志大小：${formatBytes(stats.totalSizeBytes)}`),
          ),
          React.createElement('table', { style: { borderCollapse: 'collapse', marginBottom: '8px' } },
            React.createElement('thead', null,
              React.createElement('tr', null,
                ['来源', '会话数', '总大小'].map((label, index) =>
                  React.createElement('th', { key: index, style: { border: '1px solid #ccc', padding: '4px', textAlign: 'left' } }, label)))),
            React.createElement('tbody', null,
              (stats.bySource || []).map((entry) =>
                React.createElement('tr', { key: entry.source },
                  React.createElement('td', { style: { border: '1px solid #ccc', padding: '4px' } }, sourceLabel(entry.source)),
                  React.createElement('td', { style: { border: '1px solid #ccc', padding: '4px' } }, entry.count),
                  React.createElement('td', { style: { border: '1px solid #ccc', padding: '4px' } }, formatBytes(entry.totalSizeBytes)),
                )))),
          React.createElement('details', { style: { marginBottom: '12px' } },
            React.createElement('summary', null, '查看每会话指标'),
            React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%', marginTop: '4px' } },
              React.createElement('thead', null,
                React.createElement('tr', null,
                  ['标题', '来源', '大小', '消息数', '时长', '工具调用（成功/无结果）'].map((label, index) =>
                    React.createElement('th', { key: index, style: { border: '1px solid #ccc', padding: '4px', textAlign: 'left' } }, label)))),
              React.createElement('tbody', null,
                (stats.sessions || []).map((session) =>
                  React.createElement('tr', { key: session.id },
                    React.createElement('td', { style: { border: '1px solid #ccc', padding: '4px' } }, session.title || session.id),
                    React.createElement('td', { style: { border: '1px solid #ccc', padding: '4px' } }, sourceLabel(session.source)),
                    React.createElement('td', { style: { border: '1px solid #ccc', padding: '4px' } }, formatBytes(session.sizeBytes)),
                    React.createElement('td', { style: { border: '1px solid #ccc', padding: '4px' } }, String(session.messageCount)),
                    React.createElement('td', { style: { border: '1px solid #ccc', padding: '4px' } }, formatDuration(session.durationMs)),
                    React.createElement('td', { style: { border: '1px solid #ccc', padding: '4px' } }, `${session.toolCalls}（${session.toolSuccess}/${session.toolNoResult}）`),
                  ))))),
        ) : loading ? React.createElement('div', null, '统计加载中…') : null,
        React.createElement('h3', null, '批量清理规则'),
        React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px', alignItems: 'center' } },
          React.createElement('label', null, '早于（天）',
            React.createElement('input', {
              type: 'number',
              min: '0',
              value: olderThanDays,
              onChange: (event) => setOlderThanDays(event.target.value),
              style: { width: '70px', marginLeft: '4px', padding: '4px' },
            })),
          React.createElement('label', null, '大于（MB）',
            React.createElement('input', {
              type: 'number',
              min: '0',
              value: largerThanMb,
              onChange: (event) => setLargerThanMb(event.target.value),
              style: { width: '80px', marginLeft: '4px', padding: '4px' },
            })),
          React.createElement('label', null,
            React.createElement('input', {
              type: 'checkbox',
              checked: emptySessions,
              onChange: (event) => setEmptySessions(event.target.checked),
            }), '空会话'),
          React.createElement('label', null,
            React.createElement('input', {
              type: 'checkbox',
              checked: archivedOnly,
              onChange: (event) => setArchivedOnly(event.target.checked),
            }), '仅已归档'),
          React.createElement('select', {
            value: source,
            onChange: (event) => setSource(event.target.value),
            'aria-label': '清理来源筛选',
          }, sourceOptions.map((value) =>
            React.createElement('option', { key: value, value }, value === 'all' ? '全部来源' : value))),
          React.createElement('button', { onClick: runPreview, disabled: loading }, '生成预览'),
        ),
        error ? React.createElement('div', { style: { color: 'red', marginBottom: '8px' } }, String(error)) : null,
        report ? React.createElement('div', { style: { marginBottom: '8px', padding: '8px', border: '1px solid #ccc', background: '#f9f9f9' } },
          React.createElement('h3', { style: { marginTop: 0 } }, `清理报告：成功 ${report.success} / 失败 ${report.failed}`),
          React.createElement('ul', { style: { margin: 0, paddingLeft: '20px' } },
            (report.items || []).map((item, index) =>
              React.createElement('li', { key: `${item.sessionId}-${index}` },
                `${item.sessionId} — ${item.status}${item.path ? `（${item.path}）` : ''}${item.reason ? `：${item.reason}` : ''}`))),
        ) : null,
        preview ? React.createElement('div', { style: { marginTop: '8px' } },
          React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px', alignItems: 'center' } },
            React.createElement('strong', null, `预览：${preview.total} 个候选，共 ${formatBytes(preview.totalSizeBytes)}`),
            React.createElement('input', {
              placeholder: '清理需键入 DELETE',
              value: deleteToken,
              onChange: (event) => setDeleteToken(event.target.value),
              style: { padding: '4px', width: '180px' },
              'aria-label': '清理确认令牌',
            }),
            React.createElement('button', {
              onClick: runExecute,
              disabled: selectedCount === 0 || loading,
              style: { fontWeight: 'bold' },
            }, `清理所选（${selectedCount}）`),
          ),
          (preview.excluded || []).length > 0
            ? React.createElement('div', { style: { color: '#b00', marginBottom: '8px', fontSize: '12px' } },
                `已自动排除运行中会话：${preview.excluded.map((item) => item.title || item.sessionId).join('、')}`)
            : null,
          React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%' } },
            React.createElement('thead', null,
              React.createElement('tr', null,
                ['', '标题', '来源', '最后活跃', '大小', '匹配规则'].map((label, index) =>
                  React.createElement('th', { key: index, style: { border: '1px solid #ccc', padding: '4px', textAlign: 'left' } }, label)))),
            React.createElement('tbody', null,
              previewItems.length === 0
                ? React.createElement('tr', null, React.createElement('td', { colSpan: 6, style: { padding: '8px' } }, '没有候选会话'))
                : previewItems.map((item) =>
                  React.createElement('tr', { key: item.id, style: { border: '1px solid #ccc' } },
                    React.createElement('td', { style: { padding: '4px' } },
                      React.createElement('input', {
                        type: 'checkbox',
                        checked: Boolean(selected[item.id]),
                        onChange: () => toggle(item.id),
                        'aria-label': `选择 ${item.title || item.id}`,
                      })),
                    React.createElement('td', { style: { padding: '4px' } }, item.title || item.id),
                    React.createElement('td', { style: { padding: '4px' } }, sourceLabel(item.source)),
                    React.createElement('td', { style: { padding: '4px' } }, formatDate(item.updatedAt)),
                    React.createElement('td', { style: { padding: '4px' } }, formatBytes(item.sizeBytes)),
                    React.createElement('td', { style: { padding: '4px' } }, item.matchedRules.join(', ')))))),
        ) : null,
      )
    }

    function SessionManagementSection() {
      const [tab, setTab] = useState('sessions')
      return React.createElement('div', null,
        React.createElement('h2', null, '会话管理'),
        React.createElement('div', { style: { display: 'flex', gap: '4px', marginBottom: '8px', borderBottom: '1px solid #ccc' } },
          React.createElement('button', {
            onClick: () => setTab('sessions'),
            style: { padding: '4px 12px', fontWeight: tab === 'sessions' ? 'bold' : 'normal', border: '1px solid #ccc', borderBottom: 'none', background: '#fff', cursor: 'pointer' },
          }, '会话'),
          React.createElement('button', {
            onClick: () => setTab('import'),
            style: { padding: '4px 12px', fontWeight: tab === 'import' ? 'bold' : 'normal', border: '1px solid #ccc', borderBottom: 'none', background: '#fff', cursor: 'pointer' },
          }, '导入'),
          React.createElement('button', {
            onClick: () => setTab('cleanup'),
            style: { padding: '4px 12px', fontWeight: tab === 'cleanup' ? 'bold' : 'normal', border: '1px solid #ccc', borderBottom: 'none', background: '#fff', cursor: 'pointer' },
          }, '清理与统计'),
        ),
        tab === 'sessions' ? React.createElement(SessionsSection)
          : tab === 'import' ? React.createElement(ImportSection)
            : React.createElement(CleanupSection),
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
        }, SessionManagementSection),
      ), '@dsh-external/dsh-session-management: settings section')
    }

    return { inject, apply }
  },
})
}