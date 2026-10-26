import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/**
 * key 草稿校验单测（客户端半）。
 *
 * 存在的理由：设置页「单 provider 多 key」的保存曾经只在 Host 侧校验，
 * 界面先把行加上、点保存才被 400 打回（英文 "invalid credential reference
 * name"），用户看到的就是「添加生效了但保存说无效」。本回归把两边口径钉死：
 *   1) 形状规则与 Host 半 KEY_REF_PATTERN 必须完全一致（防漂移）；
 *   2) 四类拒绝（形状 / 条目内重复 / 跨条目重复 / 未知条目）在界面侧前置拦截；
 *   3) Host 英文错误必须翻成可操作中文。
 */

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
const source = readFileSync(clientPath, 'utf8')
const hostPath = fileURLToPath(new URL('../index.js', import.meta.url))
const hostSource = readFileSync(hostPath, 'utf8')

let definition
const sandbox = {
  window: { __ModuleLoader__: { load(value) { definition = value } } },
  document: { head: { appendChild() {} }, createElement() { return { parentNode: null, setAttribute() {}, textContent: '' } } },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  AbortSignal,
  setInterval: () => 0,
  clearInterval() {},
  console,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: clientPath })

const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}
const plugin = definition.factory((specifier) => {
  if (specifier === 'react') return react
  throw new Error('unexpected module: ' + specifier)
})
const T = plugin.__test

const failures = []
const check = (label, ok, extra) => {
  if (ok === true) console.log('  ok   ' + label)
  else {
    failures.push(label)
    console.log('  FAIL ' + label + (extra === undefined ? '' : ' — ' + extra))
  }
}
const contains = (text, part) => String(text).includes(part)

console.log('key 引用名校验单测:')

check('导出校验函数', T !== undefined && typeof T.describeRefIssue === 'function' && typeof T.reviewKeyDraft === 'function')

// 1) 形状口径与 Host 半一致
const hostPattern = /const KEY_REF_PATTERN = (\/[^\r\n]+)\r?\n/.exec(hostSource)
const clientPattern = String(T.REF_NAME_PATTERN)
check('形状正则在两半一致', hostPattern !== null && hostPattern[1] === clientPattern,
  'host=' + (hostPattern === null ? '(not found)' : hostPattern[1]) + ' client=' + clientPattern)

// 2) 合法引用名
check('合法引用名不报问题', T.describeRefIssue('AIS_2DSGLM_API_KEY_2') === '')
check('下划线开头的引用名合法', T.describeRefIssue('_MY_KEY') === '')
check('空行不报问题（保存时被过滤）', T.describeRefIssue('') === '')

// 3) 非法形状的具体原因
check('数字开头被拒并说明原因', contains(T.describeRefIssue('2DSGLM_KEY'), '不能以数字开头'))
check('首尾空格被指出', contains(T.describeRefIssue(' MY_KEY'), '首尾有空格'))
check('内部空格被指出', contains(T.describeRefIssue('MY KEY'), '不能包含空格'))
check('横线名不被误判为密钥值', contains(T.describeRefIssue('DEEPSEEK-KEY'), '只能使用字母、数字、下划线'))
check('密钥值被识别', contains(T.describeRefIssue('sk-ant-api03-abcdef'), '看起来是密钥值'))
check('超长但合法的标识符仍按引用名接受', T.describeRefIssue('A1'.repeat(30)) === '')
check('带横线的长密钥串被识别', contains(T.describeRefIssue('sk-proj-' + 'a1B2'.repeat(10)), '看起来是密钥值'))

// 4) 整表预检
const okMap = { ais: ['AIS_2DSGLM_API_KEY', 'AIS_2DSGLM_API_KEY_2'], opencodego: ['OPENCODE_API_KEY'] }
check('正常多 key 列表无问题', T.reviewKeyDraft(okMap).length === 0)

const sharedRows = T.reviewKeyDraft({ ais: ['SHARED_KEY'], opencodego: ['SHARED_KEY'] })
check('跨条目重复被前置拦截', sharedRows.length === 1 && contains(sharedRows[0].message, '已被条目 ais'),
  JSON.stringify(sharedRows))

const dupRows = T.reviewKeyDraft({ ais: ['DUP_KEY', 'DUP_KEY'] })
check('条目内重复被前置拦截', dupRows.length === 1 && contains(dupRows[0].message, '同一录入内重复'),
  JSON.stringify(dupRows))

check('空行不参与去重判定', T.reviewKeyDraft({ ais: ['', 'OK_KEY', ''] }).length === 0)
check('非法名报在对应行', (() => {
  const rows = T.reviewKeyDraft({ ais: ['OK_KEY', 'bad-name'] })
  return rows.length === 1 && rows[0].index === 1 && rows[0].entryId === 'ais'
})())

// 5) 提交体整理
const shaped = T.keyDraftMap({ ais: [' A ', '', 'B'], opencodego: [''] })
check('提交体去空白/丢空行', JSON.stringify(shaped) === JSON.stringify({ ais: ['A', 'B'] }), JSON.stringify(shaped))
check('全空条目不入提交体（= 删除覆盖）', Object.keys(T.keyDraftMap({ ais: [''] })).length === 0)
check('脏标记不受条目顺序影响', T.normalizedKeyMap({ b: ['X'], a: ['Y'] }) === T.normalizedKeyMap({ a: ['Y'], b: ['X'] }))
check('脏标记保留轮换顺序', T.normalizedKeyMap({ a: ['X', 'Y'] }) !== T.normalizedKeyMap({ a: ['Y', 'X'] }))

// 6) Host 英文错误 -> 中文
const invalidMessage = T.friendlyKeyError('keysByEntry.ais has an invalid credential reference name: "bad-name"')
check('非法名错误中文化', contains(invalidMessage, '引用名「bad-name」不合法') && contains(invalidMessage, '不填密钥值'), invalidMessage)
const repeatsMessage = T.friendlyKeyError('keysByEntry.ais repeats credential reference: DUP_KEY')
check('条目内重复错误中文化', contains(repeatsMessage, '重复了同一个引用名'), repeatsMessage)
const unknownMessage = T.friendlyKeyError('keysByEntry has unknown entry id: nope')
check('未知条目错误中文化', contains(unknownMessage, '重新读取'), unknownMessage)
const sharedMessage = T.friendlyKeyError('credential reference "X" is used by both entry ais and entry opencodego')
check('跨条目重复错误中文化', contains(sharedMessage, 'ais') && contains(sharedMessage, 'opencodego'), sharedMessage)
const arrayMessage = T.friendlyKeyError('keysByEntry.ais must be an array of credential reference names')
check('数组形状错误中文化', contains(arrayMessage, '必须是引用名数组'), arrayMessage)
const mapMessage = T.friendlyKeyError('keysByEntry must be an object mapping entry id to credential reference names')
check('映射形状错误中文化', contains(mapMessage, '条目 id → 引用名数组'), mapMessage)
check('识别不了的原样返回', T.friendlyKeyError('settings service is not composed; edit the profile patch instead') === 'settings service is not composed; edit the profile patch instead')

// 7) 界面接线（字符串级）：保存路径必须前置拦截、主保存必须带上 key 草稿
check('保存前整表预检接线', contains(source, 'const keyRows = reviewKeyDraft(keyDraft)'))
check('主保存一并提交 key 草稿', contains(source, 'payload.keysByEntry = keyDraftShape'))
check('主保存按钮在 key 脏时可用', contains(source, '(dirty !== true && keyDirty !== true)'))
check('行内错误渲染', contains(source, 'keyProblemOf(entry.id, index)'))
check('保存失败走中文化', contains(source, 'setKeyError(friendlyKeyError(err.message))'))

console.log(failures.length === 0 ? '\nALL PASSED' : '\nFAILURES: ' + String(failures.length))
process.exitCode = failures.length === 0 ? 0 : 1
