/**
 * 关系图（P2-21）
 * 数据来源只有两个：设定条目正文里的 [[双链]]/@提及，以及正文里的共现。
 * 不引入图计算库 —— 力导向布局是自研的 60 行，够用且可控。
 */
import type { Chapter, SettingEntry } from './types'
import { extractRefs } from './links'

export interface GraphNode {
  id: string
  name: string
  /** 'chapter' 表示这是章节节点（可选开启） */
  kind: SettingEntry['kind'] | 'chapter'
  /** 出场的章节数 / 提及次数，决定圆点大小 */
  weight: number
  degree: number
  x: number
  y: number
  /** 是否被当前筛选隐藏 */
  hidden?: boolean
}

export interface GraphEdge {
  source: string
  target: string
  /** 关系强度：显式链接权重高，共现权重低 */
  weight: number
  kind: 'link' | 'cooccur' | 'chapter'
  label?: string
}

export interface GraphData {
  nodes: GraphNode[]
  /** 完整边集：统计（度数、连通分量、枢纽）用它，别拿它去画 */
  edges: GraphEdge[]
  /**
   * 画布上真正画出来的那些边（最多 `GraphOptions.maxEdges` 条，最强的优先）。
   * 力导向布局也是拿它算的 —— 用四万条密度图算出来的位置本来就没人看得懂，
   * 而且那些边根本不显示。没设 maxEdges 时它就等于 `edges`。
   */
  drawnEdges: GraphEdge[]
}

export interface GraphOptions {
  /** 把章节也作为节点画进来 */
  includeChapters?: boolean
  /** 共现阈值：同一章里同时出现几次才算有关系 */
  cooccurMin?: number
  /** 只保留强度 >= 该值的边 */
  minWeight?: number
  kinds?: Array<SettingEntry['kind']>
  /**
   * 画布容量上限。SVG 一条线一个 DOM 节点，一部 300 章的作品光共现就有四万条，
   * 全画出来浏览器直接僵住。设了就只保留最强的这些（显式链接永远优先），
   * 并把布局限制在同一批边上。
   */
  maxEdges?: number
}

/** 名称 → 条目（含别名） */
function nameLookup(entries: SettingEntry[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const e of entries) {
    m.set(e.name, e.id)
    for (const a of e.aliases) m.set(a, e.id)
  }
  return m
}

/** 正文中是否出现该条目的任一名称 */
function hasName(text: string, e: SettingEntry): boolean {
  if (text.includes(e.name)) return true
  return e.aliases.some((a) => text.includes(a))
}

/** 数一个 32 位整数里有几个 1（位图求交集大小用） */
function popcount(x: number): number {
  x = x - ((x >> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333)
  x = (x + (x >> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >> 24
}

export function buildGraph(
  entries: SettingEntry[],
  chapters: Chapter[],
  bodies: Record<string, string>,
  opts: GraphOptions = {}
): GraphData {
  const includeChapters = opts.includeChapters ?? false
  const cooccurMin = opts.cooccurMin ?? 2
  const lookup = nameLookup(entries)

  const nodes: GraphNode[] = entries.map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    weight: 0,
    degree: 0,
    x: 0,
    y: 0
  }))
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const edgeMap = new Map<string, GraphEdge>()

  function addEdge(a: string, b: string, w: number, kind: GraphEdge['kind']) {
    if (a === b) return
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    const prev = edgeMap.get(key)
    if (prev) {
      prev.weight += w
      // 显式链接优先级高于共现
      if (kind === 'link') prev.kind = 'link'
    } else {
      edgeMap.set(key, { source: a, target: b, weight: w, kind })
    }
  }

  /* 1. 显式链接：设定条目正文里写出的 [[X]] / @X */
  for (const e of entries) {
    for (const ref of extractRefs(e.body)) {
      const target = lookup.get(ref)
      if (target) addEdge(e.id, target, 3, 'link')
    }
    // front matter 里作者手写的关系字段（如 隶属:XX、敌对:XX）
    for (const [k, v] of Object.entries(e.fields)) {
      if (!v) continue
      for (const ref of extractRefs(String(v))) {
        const target = lookup.get(ref)
        if (target) addEdge(e.id, target, 4, 'link')
      }
      const direct = lookup.get(String(v).trim())
      if (direct) addEdge(e.id, direct, 4, 'link')
    }
  }

  /* 2. 正文共现：同一章里同时出现的条目算有关系
   *
   * 朴素写法是「每章 × 本章出现的条目两两组合」：300 章、每章 60 个条目就是
   * C(60,2)×300 ≈ 53 万次建边 —— 而其中九成因为共现次数不够，最后又被
   * cooccurMin 滤掉了，纯属白算（实测 85 万字要 1.1 秒）。
   *
   * 换个角度看：两个条目的共现强度，就是「它们各自的出场章节集合」的交集大小。
   * 于是把每个条目的出场记成**章节位图**，两两条目按位与再数 1 就够了 ——
   * 120 个条目的两两组合只有 7140 对，每对 10 个 32 位字，几十万次位运算而已。
   * 强度算出来再决定建不建边，阈值以下的根本不进 Map。
   */
  const words = (chapters.length + 31) >> 5
  const bits = entries.map(() => new Uint32Array(words))
  const chapterNodes: GraphNode[] = []

  for (let ci = 0; ci < chapters.length; ci++) {
    const ch = chapters[ci]
    const text = bodies[ch.id] || ''
    if (!text.trim()) continue
    const present: SettingEntry[] = []
    for (let ei = 0; ei < entries.length; ei++) {
      const e = entries[ei]
      if (!hasName(text, e)) continue
      present.push(e)
      bits[ei][ci >> 5] |= 1 << (ci & 31)
      const n = nodeById.get(e.id)
      if (n) n.weight++
    }
    if (includeChapters) {
      const cn: GraphNode = { id: `ch:${ch.id}`, name: ch.title, kind: 'chapter', weight: 1, degree: 0, x: 0, y: 0 }
      chapterNodes.push(cn)
      nodeById.set(cn.id, cn)
      for (const e of present) addEdge(cn.id, e.id, 1, 'chapter')
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]
    const bi = bits[i]
    for (let j = i + 1; j < entries.length; j++) {
      const bj = bits[j]
      let n = 0
      for (let w = 0; w < words; w++) n += popcount(bi[w] & bj[w])
      if (!n) continue
      // 这一对如果已经有一条显式链接，共现权重就叠加上去（和原来的行为一致 ——
      // 显式链接的边不受 cooccurMin 约束）；否则低于阈值就别建了。
      const b = entries[j]
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
      if (n < cooccurMin && !edgeMap.has(key)) continue
      addEdge(a.id, b.id, n, 'cooccur')
    }
  }

  nodes.push(...chapterNodes)

  // 共现边的阈值已经在建边时用掉了（见上），这里只剩加权过滤
  let edges = [...edgeMap.values()]
  const minWeight = opts.minWeight ?? 0
  if (minWeight > 0) edges = edges.filter((e) => e.weight >= minWeight)
  if (opts.kinds?.length) {
    const keep = new Set(opts.kinds)
    nodes.forEach((n) => {
      if (n.kind !== 'chapter' && !keep.has(n.kind as any)) n.hidden = true
    })
    const visible = new Set(nodes.filter((n) => !n.hidden).map((n) => n.id))
    edges = edges.filter((e) => visible.has(e.source) && visible.has(e.target))
  }

  for (const e of edges) {
    const a = nodeById.get(e.source)
    const b = nodeById.get(e.target)
    if (a) a.degree++
    if (b) b.degree++
  }

  // 布局与绘制用同一批边：显式 [[双链]] 优先，其余按强度（共现次数）排。
  const maxEdges = opts.maxEdges ?? 0
  let drawnEdges = edges
  if (maxEdges > 0 && edges.length > maxEdges) {
    const rank = (e: GraphEdge) => (e.kind === 'link' ? 1e6 : 0) + e.weight
    drawnEdges = [...edges].sort((a, b) => rank(b) - rank(a)).slice(0, maxEdges)
  }

  layout(nodes, drawnEdges)
  return { nodes, edges, drawnEdges }
}

/**
 * 轻量力导向布局：斥力 + 弹簧 + 中心引力。
 * 直接就地写回 node.x / node.y，结果可复现（初始位置按序号环形散布，不随机）。
 *
 * 性能上踩过一个坑，记在这里免得再犯（300 章作品的实测）：
 *  - 弹簧那一圈原来写的是 `live.find(n => n.id === e.source)`。四万条边 × 260 次迭代
 *    就是**十亿级**的线性查找。改成先建一次「id → 下标」表，这一项直接从 38 秒掉到毫秒级。
 *  - 原来每一轮迭代都 new 两个 `Map<string, number>` 存受力。四十万次 Map 哈希同样是肉眼可见的开销，
 *    换成按「live 数组下标」寻址的 Float64Array —— 节点的 id 是字符串，但下标是整数。
 * 两处都不改算法（受力顺序、随机源、迭代次数都原样保留），所以布局结果与改之前逐像素一致。
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[], iterations = 260, width = 900, height = 620) {
  const live = nodes.filter((n) => !n.hidden)
  const n = live.length
  if (!n) return

  // 确定性初始位置：环形散布，避免每次打开图都在跳
  const pos = new Map<string, number>()
  live.forEach((node, i) => {
    pos.set(node.id, i)
    const a = (i / n) * Math.PI * 2
    const r = Math.min(width, height) * 0.32
    node.x = width / 2 + Math.cos(a) * r
    node.y = height / 2 + Math.sin(a) * r
  })

  // 边换算成下标三元组 [源, 目标, 权重]；两端有一端被筛掉的直接丢
  const ei = new Float64Array(edges.length * 3)
  let eiLen = 0
  for (const e of edges) {
    const a = pos.get(e.source)
    const b = pos.get(e.target)
    if (a === undefined || b === undefined) continue
    ei[eiLen++] = a
    ei[eiLen++] = b
    ei[eiLen++] = e.weight
  }

  const fx = new Float64Array(n)
  const fy = new Float64Array(n)
  const cx = width / 2
  const cy = height / 2
  const k = Math.sqrt((width * height) / Math.max(1, n)) * 0.55

  for (let it = 0; it < iterations; it++) {
    const cooling = 1 - it / iterations
    fx.fill(0)
    fy.fill(0)

    // 斥力
    for (let i = 0; i < n; i++) {
      const a = live[i]
      for (let j = i + 1; j < n; j++) {
        const b = live[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = (i % 2 ? 1 : -1) * 0.6
          dy = (j % 2 ? 1 : -1) * 0.6
          d2 = 1
        }
        const d = Math.sqrt(d2)
        const rep = (k * k) / d2
        const ux = (dx / d) * rep
        const uy = (dy / d) * rep
        fx[i] += ux
        fy[i] += uy
        fx[j] -= ux
        fy[j] -= uy
      }
    }

    // 弹簧
    for (let t = 0; t < eiLen; t += 3) {
      const ia = ei[t]
      const ib = ei[t + 1]
      const a = live[ia]
      const b = live[ib]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.max(1, Math.hypot(dx, dy))
      const pull = ((d - k * 0.8) * ei[t + 2]) / 12
      const ux = (dx / d) * pull
      const uy = (dy / d) * pull
      fx[ia] += ux
      fy[ia] += uy
      fx[ib] -= ux
      fy[ib] -= uy
    }

    // 中心引力 + 位移
    for (let i = 0; i < n; i++) {
      const node = live[i]
      const fxi = fx[i] + (cx - node.x) * 0.015
      const fyi = fy[i] + (cy - node.y) * 0.015
      const len = Math.max(0.001, Math.hypot(fxi, fyi))
      const step = Math.min(14, len) * cooling
      node.x += (fxi / len) * step
      node.y += (fyi / len) * step
      node.x = Math.max(24, Math.min(width - 24, node.x))
      node.y = Math.max(24, Math.min(height - 24, node.y))
    }
  }
}

/** 连通分量：孤立的小团体（比如只跟自己卷内人物有关系）一眼看出来 */
export function components(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>()
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) {
    adj.get(e.source)?.push(e.target)
    adj.get(e.target)?.push(e.source)
  }
  const seen = new Set<string>()
  const out: string[][] = []
  for (const n of nodes) {
    if (seen.has(n.id)) continue
    const group: string[] = []
    const stack = [n.id]
    seen.add(n.id)
    while (stack.length) {
      const cur = stack.pop()!
      group.push(cur)
      for (const nb of adj.get(cur) || []) {
        if (!seen.has(nb)) {
          seen.add(nb)
          stack.push(nb)
        }
      }
    }
    out.push(group)
  }
  return out.sort((a, b) => b.length - a.length)
}

/** 按度数列前 N 个核心节点 */
export function hubs(nodes: GraphNode[], top = 8): GraphNode[] {
  return [...nodes].filter((n) => !n.hidden).sort((a, b) => b.degree - a.degree || b.weight - a.weight).slice(0, top)
}
