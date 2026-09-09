// Run with a Playwright Page on a DSH web host. Only pass disposable test
// session IDs: this check archives, unarchives and permanently deletes it.
const assert = require('node:assert/strict')

module.exports = async function checkSessionUi(page, { sessionId, title }) {
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '会话管理', exact: true }).click()
  const row = page.locator(`.dshsm tr[data-id="${sessionId}"]`)
  await row.waitFor()
  assert.ok((await row.innerText()).includes(title), 'persisted title is visible')
  const checkbox = row.getByRole('checkbox')
  await checkbox.check()
  assert.equal(await checkbox.isChecked(), true)
  await checkbox.uncheck()
  await row.getByRole('button', { name: '归档', exact: true }).click()
  await row.getByRole('button', { name: '取消归档', exact: true }).waitFor()
  await row.getByRole('button', { name: '取消归档', exact: true }).click()
  await row.getByRole('button', { name: '归档', exact: true }).waitFor()
  await row.getByRole('button', { name: '删除', exact: true }).click()
  await page.locator('.dshsm-modal').waitFor()
  await page.locator('.dshsm-m-cancel').click()
  assert.equal(await row.count(), 1, 'cancel preserves the session')
  await row.getByRole('button', { name: '删除', exact: true }).click()
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/delete'))
  await page.locator('.dshsm-m-confirm').click()
  const response = await responsePromise
  assert.equal(response.status(), 200, await response.text())
  await row.waitFor({ state: 'detached' })
  return 'PASS: title, checkbox, archive, unarchive, cancel and delete'
}
