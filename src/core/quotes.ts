/**
 * 中文正文的引号规范化（纯函数，零依赖）
 *
 * 为什么要有这一层：
 * 模型（尤其是英文语料占大头那些）写中文对话时，十有八九吐英文直引号 ——
 * 「他说"跟我走"」这种。中文排版里对话应该是 “跟我走”。
 * 光靠提示词压不住（长文本生成到后面自己就忘了），所以这里再做一次确定性兜底。
 *
 * 三条边界：
 * 1. **代码块不动**。``` 围栏与 `行内代码` 里的引号是语法，改了就是 bug。
 * 2. **只处理成对出现的引号**。落单的那个通常是英寸符号、截断的半截话，
 *    硬改成 “ 只会让它更难懂，所以原样留下。
 * 3. 不做全角/半角、顿号逗号之类的其它标点改造 —— 那些是作者自己的排版习惯，
 *    工具不该替作者决定。
 */

function convertProse(s: string): string {
  let out = ''
  let open = false
  let lastOpenAt = -1
  for (const ch of s) {
    if (ch !== '"') {
      out += ch
      continue
    }
    if (open) {
      out += '”'
      open = false
      lastOpenAt = -1
    } else {
      out += '“'
      open = true
      lastOpenAt = out.length - 1
    }
  }
  // 最后那个没配上对的（open 仍为 true）退回原样
  if (open && lastOpenAt >= 0) out = out.slice(0, lastOpenAt) + '"' + out.slice(lastOpenAt + 1)
  return out
}

/**
 * 一行里的反引号成对包住的是行内代码，那些引号不动。
 * 奇数个反引号（断行 / 手滑）时，剩下的那段按正文处理 —— 别把后面全判成代码。
 */
function convertLine(line: string): string {
  if (!line.includes('`')) return convertProse(line)
  let out = ''
  let rest = line
  while (rest.includes('`')) {
    const a = rest.indexOf('`')
    out += convertProse(rest.slice(0, a))
    const b = rest.indexOf('`', a + 1)
    if (b < 0) {
      out += '`' + convertProse(rest.slice(a + 1))
      return out
    }
    out += rest.slice(a, b + 1)
    rest = rest.slice(b + 1)
  }
  return out + convertProse(rest)
}

/** 把正文里的英文直引号成对换成中文双引号，代码块保持不动 */
export function normalizeDialogQuotes(text: string): string {
  if (!text || !text.includes('"')) return text
  const out: string[] = []
  let fence = false
  let marker = ''
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (fence) {
      out.push(line)
      if (t.startsWith(marker)) {
        fence = false
        marker = ''
      }
      continue
    }
    const m = /^(```|~~~)/.exec(t)
    if (m) {
      fence = true
      marker = m[1]
      out.push(line)
      continue
    }
    out.push(convertLine(line))
  }
  return out.join('\n')
}

/** 正文类任务共用的输出规范：写进提示词，让它第一遍就写对 */
export const CN_PUNCT_RULE = [
  '输出规范（必须遵守）：',
  '1. 人物对话一律用中文双引号“”，禁止使用英文直引号 " 或直角引号「」。',
  '2. 其余标点也用中文全角：，。！？；：……（ ）',
  '3. 不要输出章节标题、不要输出 Markdown 代码块。'
].join('\n')
