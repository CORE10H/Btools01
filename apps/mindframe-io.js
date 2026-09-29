/* =====================================================================
   MINDFRAME：テキスト入出力と自動整列（純粋関数のみ）
   ---------------------------------------------------------------------
   - DOM やアプリの状態には一切触れない。入力を受けて結果を返すだけ
   - window.MFIO に公開し、mindframe.js から使う
   含むもの：
     ・箇条書き（Markdown の見出し／リスト、インデント）→ 木構造
     ・Mermaid の flowchart / graph（よく使う記法の範囲）→ ノードと線
     ・Mermaid の mindmap → 木構造
     ・階層型の自動整列（Sugiyama 法：閉路除去→層割り当て→重心法で並べ替え→座標決め）
     ・木構造 → 箇条書き、図 → Mermaid への書き出し
===================================================================== */
(function () {
  'use strict';

  const MAX_ITEMS = 2000;   // 1回の読み込みで作るノードの上限（巨大な貼り付けで固まらないように）
  const MAX_LABEL = 500;    // 1ノードの文字数の上限
  const MAX_STATEMENT = 3000; // Mermaid の1文の長さの上限

  /* ---------- 共通 ---------- */

  // AI の出力にありがちな ```mermaid … ``` を外す（最初のコードブロックだけを使う）
  function stripFences(text) {
    const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const m = t.match(/```[ \t]*[\w-]*[ \t]*\n([\s\S]*?)```/);
    return m ? m[1] : t;
  }

  // 先頭の front matter（--- ～ ---）と %% のコメント・空行を飛ばした行の配列
  function meaningfulLines(text) {
    const lines = stripFences(text).split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i < lines.length && lines[i].trim() === '---') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '---') j++;
      if (j < lines.length) i = j + 1;
    }
    return lines.slice(i);
  }

  function firstLine(lines) {
    for (const l of lines) {
      const s = l.trim();
      if (!s || s.startsWith('%%')) continue;
      return s;
    }
    return '';
  }

  // 'mermaid'（フローチャート）／'mindmap'（Mermaid のマインドマップ）／'outline'（箇条書き）
  function detectFormat(text) {
    const head = firstLine(meaningfulLines(text));
    if (/^(flowchart|graph)\b/i.test(head)) return 'mermaid';
    if (/^mindmap\b/i.test(head)) return 'mindmap';
    return 'outline';
  }

  // Markdown の装飾を外して素の文字にする
  function cleanInline(s) {
    return String(s)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+$/, '')
      .trim();
  }

  /* ---------- 箇条書き → 木構造 ---------- */

  const LIST_MARK = /^(?:[-*+・●○■□◆◇▪▫►▶→]|\d{1,3}[.)．、]|[①-⑳])\s*/;

  // items: [{ text, indent, heading }] → [{ text, children }]
  function buildForest(items) {
    const headings = items.filter((it) => it.heading).map((it) => it.heading);
    const minHeading = headings.length ? Math.min.apply(null, headings) : 7;
    let headDepth = -1;
    let stack = [];
    items.forEach((it) => {
      if (it.heading) {
        it.depth = it.heading - minHeading;
        headDepth = it.depth;
        stack = [];
      } else {
        while (stack.length && it.indent < stack[stack.length - 1]) stack.pop();
        if (!stack.length || it.indent > stack[stack.length - 1]) stack.push(it.indent);
        it.depth = headDepth + 1 + (stack.length - 1);
      }
    });
    const forest = [];
    const path = [];
    items.forEach((it) => {
      const d = Math.max(0, Math.min(it.depth, path.length)); // 飛び級は直前の深さ＋1に丸める
      const node = { text: it.text, children: [] };
      if (d === 0) forest.push(node);
      else path[d - 1].children.push(node);
      path.length = d;
      path.push(node);
    });
    return forest;
  }

  function parseOutline(text) {
    const items = [];
    for (const raw of stripFences(text).split('\n')) {
      if (!raw.trim()) continue;
      const line = raw.replace(/\t/g, '    ').replace(/　/g, '  ');
      const indent = line.match(/^ */)[0].length;
      let s = line.slice(indent);
      let heading = 0;
      const h = s.match(/^(#{1,6})\s+(.*)$/);
      if (h) { heading = h[1].length; s = h[2]; }
      else if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(s.trim())) continue; // 区切り線
      else s = s.replace(LIST_MARK, '');
      s = cleanInline(s.replace(/^\[[ xX]\]\s+/, ''));
      if (!s) continue;
      items.push({ text: s.slice(0, MAX_LABEL), indent, heading });
      if (items.length >= MAX_ITEMS) break;
    }
    return buildForest(items);
  }

  // Mermaid mindmap：各行の「id((文字))」などの形を外し、インデントで木にする
  function mindmapLabel(s) {
    let t = s.trim();
    if (!t || t.startsWith('::icon') || t.startsWith('%%')) return '';
    t = t.replace(/:::[\w-]+\s*$/, '').trim();
    const m = t.match(/^[^\s([{)]*?\s*(\(\(|\)\)|\[\[|\{\{|\[|\(|\))([\s\S]*?)(\)\)|\(\(|\]\]|\}\}|\]|\)|\()\s*$/);
    if (m) t = m[2];
    return cleanLabel(t);
  }
  function parseMindmap(text) {
    const lines = meaningfulLines(text);
    let started = false;
    const items = [];
    for (const raw of lines) {
      if (!started) {
        if (/^\s*mindmap\b/i.test(raw)) started = true;
        continue;
      }
      if (!raw.trim()) continue;
      const line = raw.replace(/\t/g, '    ');
      const indent = line.match(/^ */)[0].length;
      const label = mindmapLabel(line);
      if (!label) continue;
      items.push({ text: label.slice(0, MAX_LABEL), indent, heading: 0 });
      if (items.length >= MAX_ITEMS) break;
    }
    return buildForest(items);
  }

  /* ---------- Mermaid flowchart → ノードと線 ---------- */

  // 開き括弧・閉じ括弧・形（長い記法から順に判定する）
  const SHAPE_SYNTAX = [
    ['(((', ')))', 'ellipse'],
    ['([', '])', 'pill'],
    ['[[', ']]', 'sub'],
    ['[(', ')]', 'cyl'],
    ['((', '))', 'ellipse'],
    ['{{', '}}', 'hex'],
    ['[/', null, 'para'],   // [/ … /] 平行四辺形、[/ … \] 台形（→ 四角）
    ['[\\', null, 'para'],  // [\ … \] 平行四辺形、[\ … /] 台形（→ 四角）
    ['>', ']', 'rect'],     // 旗形（→ 四角）
    ['[', ']', 'rect'],
    ['(', ')', 'round'],
    ['{', '}', 'diamond'],
  ];

  function decodeEntities(s) {
    return s
      .replace(/#quot;/g, '"').replace(/#amp;/g, '&').replace(/#lt;/g, '<').replace(/#gt;/g, '>')
      .replace(/#(\d{1,6});/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; });
  }
  function cleanLabel(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1);
    if (s.length >= 2 && s[0] === '`' && s[s.length - 1] === '`') s = s.slice(1, -1);
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '');
    s = decodeEntities(s).replace(/\\n/g, '\n');
    s = s.split('\n').map((l) => l.trim()).join('\n').trim();
    return s.slice(0, MAX_LABEL);
  }

  // ; で文を区切る（引用符・括弧の中の ; は区切りにしない）
  function splitStatements(line) {
    const out = [];
    let depth = 0, quote = false, cur = '';
    for (const ch of line) {
      if (ch === '"') quote = !quote;
      else if (!quote && '[({'.includes(ch)) depth++;
      else if (!quote && '])}'.includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === ';' && !quote && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  // from 以降で閉じ記号を探す（引用符の中は飛ばす）
  function findClose(s, from, closes) {
    let quote = false;
    for (let i = from; i < s.length; i++) {
      if (s[i] === '"') { quote = !quote; continue; }
      if (quote) continue;
      for (const c of closes) if (s.startsWith(c, i)) return { at: i, close: c };
    }
    return null;
  }

  const ID_RE = /^[\p{L}\p{N}_]+/u;
  // 線の記法（文字を挟む形 → 通常の形の順に試す）
  const INLINE_OPS = [
    /^(<)?--\s+(.+?)\s+(-{2,}>|-{3,}|--[ox])(?=[\s"\p{L}\p{N}_]|$)/u,
    /^(<)?==\s+(.+?)\s+(={2,}>|={3,})(?=[\s"\p{L}\p{N}_]|$)/u,
    /^(<)?-\.\s+(.+?)\s+(\.-+>|\.-+)(?=[\s"\p{L}\p{N}_]|$)/u,
  ];
  const PLAIN_OP = /^(<)?(-{2,}|={2,}|-\.+-|~{3,})(>|o(?=[\s|])|x(?=[\s|]))?/;

  function parseMermaid(text) {
    const lines = meaningfulLines(text);
    let dir = 'TD';
    let headerSeen = false;
    const nodes = new Map();
    const order = [];
    const edges = [];
    let skipped = 0;

    function touchNode(id, label, shape) {
      let n = nodes.get(id);
      if (!n) {
        if (order.length >= MAX_ITEMS) return null;
        n = { id, text: id, shape: 'rect' };
        nodes.set(id, n);
        order.push(id);
      }
      if (label != null) n.text = label;
      if (shape) n.shape = shape;
      return n;
    }

    function parseStatement(s) {
      let i = 0;
      const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };

      function nodeRef() {
        skipWs();
        const m = ID_RE.exec(s.slice(i));
        if (!m) return null;
        const id = m[0];
        i += id.length;
        let label = null, shape = null;
        for (const [open, close, sh] of SHAPE_SYNTAX) {
          if (!s.startsWith(open, i)) continue;
          const closes = close ? [close] : ['/]', '\\]'];
          const found = findClose(s, i + open.length, closes);
          if (!found) return null;
          label = cleanLabel(s.slice(i + open.length, found.at));
          shape = sh;
          if (!close) {
            const same = (open === '[/' && found.close === '/]') || (open === '[\\' && found.close === '\\]');
            shape = same ? 'para' : 'rect';
          }
          i = found.at + found.close.length;
          break;
        }
        const cls = /^:::[\w-]+/.exec(s.slice(i));
        if (cls) i += cls[0].length;
        return touchNode(id, label, shape) ? id : null;
      }

      function nodeGroup() {
        const ids = [];
        const first = nodeRef();
        if (!first) return null;
        ids.push(first);
        for (;;) {
          const save = i;
          skipWs();
          if (s[i] !== '&') { i = save; break; }
          i++;
          const next = nodeRef();
          if (!next) return null;
          ids.push(next);
        }
        return ids;
      }

      function edgeOp() {
        skipWs();
        const rest = s.slice(i);
        for (const re of INLINE_OPS) {
          const m = re.exec(rest);
          if (m) {
            i += m[0].length;
            return opInfo(!!m[1], m[3], cleanLabel(m[2]));
          }
        }
        const m = PLAIN_OP.exec(rest);
        if (!m) return null;
        i += m[0].length;
        let label = '';
        const save = i;
        skipWs();
        if (s[i] === '|') {
          const end = s.indexOf('|', i + 1);
          if (end < 0) return null;
          label = cleanLabel(s.slice(i + 1, end));
          i = end + 1;
        } else i = save;
        return opInfo(!!m[1], m[2] + (m[3] || ''), label);
      }

      function opInfo(startArrow, body, label) {
        if (/^~+$/.test(body)) return { invisible: true };
        const endArrow = /[>ox]$/.test(body);
        const arrow = startArrow && endArrow ? 'both' : startArrow ? 'start' : endArrow ? 'end' : 'none';
        return { arrow, dashed: body.includes('.'), thick: body.includes('='), label };
      }

      const first = nodeGroup();
      if (!first) return false;
      let left = first;
      for (;;) {
        skipWs();
        if (i >= s.length) return true;
        const op = edgeOp();
        if (!op) return false;
        const right = nodeGroup();
        if (!right) return false;
        if (!op.invisible) {
          left.forEach((a) => right.forEach((b) => {
            if (edges.length < MAX_ITEMS * 2) edges.push({ from: a, to: b, label: op.label || '', arrow: op.arrow, dashed: op.dashed, thick: op.thick });
          }));
        }
        left = right;
      }
    }

    for (const raw of lines) {
      for (const part of splitStatements(raw)) {
        const s = part.trim();
        if (!s || s.startsWith('%%')) continue;
        if (s.length > MAX_STATEMENT) { skipped++; continue; } // 異常に長い行は解釈しない（固まるのを防ぐ）
        if (!headerSeen) {
          const h = s.match(/^(flowchart|graph)\b\s*(TB|TD|BT|RL|LR)?\s*(.*)$/i);
          if (h) {
            headerSeen = true;
            dir = (h[2] || 'TD').toUpperCase();
            if (dir === 'TB') dir = 'TD';
            if (h[3] && h[3].trim() && !parseStatement(h[3].trim())) skipped++;
            continue;
          }
        }
        if (/^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(s)) continue;
        if (/^subgraph\b/.test(s) || s === 'end') continue; // サブグラフは枠を作らず、中のノードだけ取り込む
        if (!parseStatement(s)) skipped++;
      }
    }
    return { dir, nodes: order.map((id) => nodes.get(id)), edges, skipped };
  }

  /* ---------- 階層型の自動整列（Sugiyama 法の簡易版） ---------- */
  // nodes: [{ id, w, h }]、edges: [{ from, to }]、dir: 'TD'|'BT'|'LR'|'RL'
  // 返り値：Map(id → { x, y })（左上座標。全体の左上が 0,0）
  function layered(nodes, edges, dir, opts) {
    const o = opts || {};
    const horizontal = dir === 'LR' || dir === 'RL';
    const reverse = dir === 'BT' || dir === 'RL';
    const LAYER_GAP = o.layerGap || 64;
    const NODE_GAP = o.nodeGap || 36;
    const N = nodes.length;
    const index = new Map(nodes.map((n, k) => [n.id, k]));
    const E = [];
    const seen = new Set();
    edges.forEach((e) => {
      const a = index.get(e.from), b = index.get(e.to);
      if (a == null || b == null || a === b) return;
      const key = a + '>' + b;
      if (seen.has(key)) return;
      seen.add(key);
      E.push([a, b]);
    });

    // 1) 閉路の除去：深さ優先探索で見つけた戻り辺を逆向きにする（反復版）
    const outList = Array.from({ length: N }, () => []);
    E.forEach((e, k) => outList[e[0]].push(k));
    const state = new Uint8Array(N);
    const reversed = new Set();
    for (let s = 0; s < N; s++) {
      if (state[s]) continue;
      state[s] = 1;
      const stack = [[s, 0]];
      while (stack.length) {
        const top = stack[stack.length - 1];
        const v = top[0];
        if (top[1] < outList[v].length) {
          const k = outList[v][top[1]++];
          const w = E[k][1];
          if (state[w] === 1) reversed.add(k);
          else if (state[w] === 0) { state[w] = 1; stack.push([w, 0]); }
        } else { state[v] = 2; stack.pop(); }
      }
    }
    const DE = E.map((e, k) => (reversed.has(k) ? [e[1], e[0]] : e));

    // 2) 層の割り当て：最長経路法。その後、入口だけのノードを行き先の直前まで下げる
    const succ = Array.from({ length: N }, () => []);
    const pred = Array.from({ length: N }, () => []);
    const indeg = new Array(N).fill(0);
    DE.forEach(([a, b]) => { succ[a].push(b); pred[b].push(a); indeg[b]++; });
    const layer = new Array(N).fill(0);
    const topo = [];
    for (let v = 0; v < N; v++) if (!indeg[v]) topo.push(v);
    for (let qi = 0; qi < topo.length; qi++) {
      const v = topo[qi];
      succ[v].forEach((w) => { layer[w] = Math.max(layer[w], layer[v] + 1); if (--indeg[w] === 0) topo.push(w); });
    }
    for (let qi = topo.length - 1; qi >= 0; qi--) {
      const v = topo[qi];
      if (!pred[v].length && succ[v].length) layer[v] = Math.min.apply(null, succ[v].map((w) => layer[w])) - 1;
    }
    const minLayer = N ? Math.min.apply(null, layer) : 0;
    for (let v = 0; v < N; v++) layer[v] -= minLayer;

    // 3) 2層以上またぐ辺にダミー（大きさ0の中継点）を挟む
    const vLayer = layer.slice();
    const up = Array.from({ length: N }, () => []);
    const down = Array.from({ length: N }, () => []);
    let vCount = N;
    DE.forEach(([a, b]) => {
      let prev = a;
      for (let L = layer[a] + 1; L < layer[b]; L++) {
        const d = vCount++;
        vLayer.push(L); up.push([]); down.push([]);
        down[prev].push(d); up[d].push(prev);
        prev = d;
      }
      down[prev].push(b); up[b].push(prev);
    });
    const layerCount = vCount ? Math.max.apply(null, vLayer) + 1 : 0;
    const layers = Array.from({ length: layerCount }, () => []);
    for (let v = 0; v < vCount; v++) layers[vLayer[v]].push(v);

    // 4) 層内の並び順：重心法で上下に交互に並べ替え（交差を減らす）
    const posIdx = new Array(vCount).fill(0);
    const setIdx = () => layers.forEach((arr) => arr.forEach((v, k) => { posIdx[v] = k; }));
    setIdx();
    for (let it = 0; it < 8; it++) {
      const downward = it % 2 === 0;
      const seq = downward ? layers.slice(1) : layers.slice(0, -1).reverse();
      seq.forEach((arr) => {
        const bc = new Map();
        arr.forEach((v) => {
          const nb = downward ? up[v] : down[v];
          bc.set(v, nb.length ? nb.reduce((s, w) => s + posIdx[w], 0) / nb.length : posIdx[v]);
        });
        arr.sort((a, b) => (bc.get(a) - bc.get(b)) || (posIdx[a] - posIdx[b]));
        arr.forEach((v, k) => { posIdx[v] = k; });
      });
    }

    // 5) 座標：層内は左から詰めて置き、隣の層の重心へ寄せる（並び順と最小間隔は守る）
    const cross = (v) => (v < N ? (horizontal ? nodes[v].h : nodes[v].w) : 0);
    const along = (v) => (v < N ? (horizontal ? nodes[v].w : nodes[v].h) : 0);
    const pos = new Array(vCount).fill(0);
    layers.forEach((arr) => {
      let x = 0;
      arr.forEach((v) => { pos[v] = x + cross(v) / 2; x += cross(v) + NODE_GAP; });
    });
    const sep = (a, b) => (cross(a) + cross(b)) / 2 + (a < N && b < N ? NODE_GAP : NODE_GAP / 2);
    for (let it = 0; it < 10; it++) {
      const useUp = it % 2 === 0;
      const seq = useUp ? layers : layers.slice().reverse();
      seq.forEach((arr) => {
        if (!arr.length) return;
        const want = arr.map((v) => {
          const nb = useUp ? up[v] : down[v];
          return nb.length ? nb.reduce((s, w) => s + pos[w], 0) / nb.length : pos[v];
        });
        const fwd = want.slice();
        for (let k = 1; k < arr.length; k++) fwd[k] = Math.max(want[k], fwd[k - 1] + sep(arr[k - 1], arr[k]));
        const bwd = want.slice();
        for (let k = arr.length - 2; k >= 0; k--) bwd[k] = Math.min(want[k], bwd[k + 1] - sep(arr[k], arr[k + 1]));
        arr.forEach((v, k) => { pos[v] = (fwd[k] + bwd[k]) / 2; });
      });
    }

    // 層の位置（層の中で一番大きいノードに合わせた帯）
    const bandSize = layers.map((arr) => arr.reduce((m, v) => Math.max(m, along(v)), 0));
    const bandStart = [];
    let acc = 0;
    bandSize.forEach((sz, L) => { bandStart[L] = acc; acc += sz + LAYER_GAP; });
    const total = Math.max(0, acc - LAYER_GAP);

    const result = new Map();
    let minX = Infinity, minY = Infinity;
    for (let v = 0; v < N; v++) {
      const L = vLayer[v];
      let a = bandStart[L] + (bandSize[L] - along(v)) / 2;
      if (reverse) a = total - a - along(v);
      const c = pos[v] - cross(v) / 2;
      const p = horizontal ? { x: a, y: c } : { x: c, y: a };
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      result.set(nodes[v].id, p);
    }
    result.forEach((p) => { p.x = Math.round(p.x - minX); p.y = Math.round(p.y - minY); });
    return result;
  }

  /* ---------- 書き出し ---------- */

  // forest: [{ text, children }] → Markdown の入れ子リスト
  function toOutline(forest) {
    const lines = [];
    const walk = (n, d) => {
      lines.push('  '.repeat(d) + '- ' + (String(n.text || '').replace(/\s*\n\s*/g, ' ').trim() || '（空）'));
      n.children.forEach((c) => walk(c, d + 1));
    };
    forest.forEach((root, k) => { if (k) lines.push(''); walk(root, 0); });
    return lines.join('\n');
  }

  const MERMAID_SHAPE = {
    rect: ['[', ']'], round: ['(', ')'], pill: ['([', '])'], diamond: ['{', '}'], para: ['[/', '/]'],
    doc: ['[', ']'], cyl: ['[(', ')]'], sub: ['[[', ']]'], hex: ['{{', '}}'], ellipse: ['((', '))'],
  };
  function mermaidText(s) {
    const t = String(s || '').replace(/"/g, '#quot;').replace(/\r?\n/g, '<br>').trim();
    return '"' + (t || ' ') + '"';
  }
  // data: { dir, nodes: [{ key, text, shape }], edges: [{ from, to, label, arrow, dashed, thick }] }
  function toMermaid(data) {
    const lines = ['flowchart ' + (data.dir || 'TD')];
    data.nodes.forEach((n) => {
      const br = MERMAID_SHAPE[n.shape] || MERMAID_SHAPE.round;
      lines.push('  ' + n.key + br[0] + mermaidText(n.text) + br[1]);
    });
    data.edges.forEach((e) => {
      let from = e.from, to = e.to, arrow = e.arrow;
      if (arrow === 'start') { from = e.to; to = e.from; arrow = 'end'; }
      let op;
      if (e.dashed) op = arrow === 'none' ? '-.-' : '-.->';
      else if (e.thick) op = arrow === 'none' ? '===' : '==>';
      else op = arrow === 'none' ? '---' : '-->';
      if (arrow === 'both') op = '<' + op;
      const label = String(e.label || '').replace(/\r?\n/g, ' ').replace(/"/g, '#quot;').replace(/\|/g, '#124;').trim();
      lines.push('  ' + from + ' ' + op + (label ? '|"' + label + '"|' : '') + ' ' + to);
    });
    return lines.join('\n');
  }

  window.MFIO = {
    MAX_ITEMS,
    stripFences,
    detectFormat,
    parseOutline,
    parseMindmap,
    parseMermaid,
    cleanLabel,
    layered,
    toOutline,
    toMermaid,
  };
})();
