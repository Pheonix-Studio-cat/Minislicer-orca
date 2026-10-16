// Evaluator for the subset of OrcaSlicer's placeholder language that the Bambu Lab start, end and
// layer-change templates use (src/libslic3r/PlaceholderParser.cpp is the full implementation):
//
//   [name]                       legacy variable
//   {expr}                       expression, e.g. {nozzle_temperature_initial_layer[initial_extruder]-20}
//   {if expr} ... {elsif expr} ... {else} ... {endif}
//
// Expressions support numbers, "strings", true/false, variables, vector indexing, + - * / %,
// comparisons, ! not && and || or, cond ? a : b, parentheses, and min/max/int/round/abs.
// A vector used without an index yields its first element (single extruder).
// An unknown variable throws, so a template that needs a value we do not supply fails loudly.

export class TemplateError extends Error {}

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+\.\d*|\.\d+|\d+)|("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z_0-9]*)|(==|!=|<=|>=|&&|\|\||[-+*/%<>!()[\],?:]))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new TemplateError(`cannot parse "${src}" at "${src.slice(pos)}"`);
    pos = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'str', v: JSON.parse(m[2]) });
    else if (m[3] !== undefined) tokens.push({ t: 'id', v: m[3] });
    else tokens.push({ t: 'op', v: m[4] });
  }
  return tokens;
}

const FUNCTIONS = {
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
  int: (a) => Math.trunc(a),
  round: (a) => Math.round(a),
  abs: (a) => Math.abs(a),
};

function scalar(v) {
  return Array.isArray(v) ? v[0] : v;
}

export function evaluate(src, vars) {
  const tokens = tokenize(src);
  let i = 0;
  let skip = 0; // > 0 while parsing a branch that is not taken: parse it, but look nothing up
  const peek = () => tokens[i];
  const isOp = (v) => tokens[i] && tokens[i].t === 'op' && tokens[i].v === v;
  const isWord = (v) => tokens[i] && tokens[i].t === 'id' && tokens[i].v === v;
  const expect = (v) => {
    if (!isOp(v)) throw new TemplateError(`expected "${v}" in "${src}"`);
    i++;
  };

  function primary() {
    const tok = peek();
    if (!tok) throw new TemplateError(`unexpected end of "${src}"`);
    if (tok.t === 'num' || tok.t === 'str') { i++; return tok.v; }
    if (isOp('(')) { i++; const v = ternary(); expect(')'); return v; }
    if (tok.t === 'id') {
      i++;
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      if (FUNCTIONS[tok.v] && isOp('(')) {
        i++;
        const args = [ternary()];
        while (isOp(',')) { i++; args.push(ternary()); }
        expect(')');
        return skip ? 0 : FUNCTIONS[tok.v](...args.map(scalar));
      }
      if (skip) {
        if (isOp('[')) { i++; ternary(); expect(']'); }
        return 0;
      }
      if (!(tok.v in vars)) throw new TemplateError(`unknown variable "${tok.v}" in "${src}"`);
      let v = vars[tok.v];
      if (isOp('[')) {
        i++;
        const idx = scalar(ternary());
        expect(']');
        if (!Array.isArray(v)) throw new TemplateError(`"${tok.v}" is not a vector`);
        if (idx < 0 || idx >= v.length) throw new TemplateError(`index ${idx} out of range for "${tok.v}"`);
        v = v[idx];
      }
      return v;
    }
    throw new TemplateError(`unexpected "${tok.v}" in "${src}"`);
  }
  function unary() {
    if (isOp('!') || isWord('not')) { i++; return !scalar(unary()); }
    if (isOp('-')) { i++; return -scalar(unary()); }
    if (isOp('+')) { i++; return +scalar(unary()); }
    return primary();
  }
  function mul() {
    let v = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[i++].v;
      const r = scalar(unary());
      v = scalar(v);
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function add() {
    let v = mul();
    while (isOp('+') || isOp('-')) {
      const op = tokens[i++].v;
      const r = scalar(mul());
      v = scalar(v);
      v = op === '+' ? (typeof v === 'string' ? v + String(r) : v + r) : v - r;
    }
    return v;
  }
  function cmp() {
    let v = add();
    while (['<', '>', '<=', '>=', '==', '!='].some(isOp)) {
      const op = tokens[i++].v;
      const r = scalar(add());
      const l = scalar(v);
      v = op === '<' ? l < r : op === '>' ? l > r : op === '<=' ? l <= r
        : op === '>=' ? l >= r : op === '==' ? l == r : l != r; // eslint-disable-line eqeqeq
    }
    return v;
  }
  function andExpr() {
    let v = cmp();
    while (isOp('&&') || isWord('and')) {
      i++;
      const lhs = Boolean(scalar(v));
      if (!lhs) skip++;
      const r = cmp();
      if (!lhs) skip--;
      v = lhs && Boolean(scalar(r));
    }
    return v;
  }
  function orExpr() {
    let v = andExpr();
    while (isOp('||') || isWord('or')) {
      i++;
      const lhs = Boolean(scalar(v));
      if (lhs) skip++;
      const r = andExpr();
      if (lhs) skip--;
      v = lhs || Boolean(scalar(r));
    }
    return v;
  }

  // cond ? a : b (right-associative), the lowest-precedence operator.
  function ternary() {
    const cond = orExpr();
    if (!isOp('?')) return cond;
    i++;
    const take = Boolean(scalar(cond));
    if (!take) skip++;
    const a = ternary();
    if (!take) skip--;
    expect(':');
    if (take) skip++;
    const b = ternary();
    if (take) skip--;
    return take ? a : b;
  }

  const result = ternary();
  if (i !== tokens.length) throw new TemplateError(`trailing input in "${src}"`);
  return result;
}

export function formatValue(v) {
  v = scalar(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TemplateError(`non-finite value ${v}`);
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  }
  return String(v);
}

// Renders a whole template. Conditionals may span lines; a line that holds nothing but a
// control tag is dropped entirely so the output has no stray blank lines.
export function render(template, vars) {
  template = template.replace(/^[ \t]*(\{\s*(?:if|elsif|else|endif)\b[^{}]*\})[ \t]*\r?\n/gm, '$1');
  const parts = template.split(/(\{[^{}]*\})/);
  // stack of { active: is this branch emitting, taken: has any branch of this if been taken }
  const stack = [];
  const emitting = () => stack.every((s) => s.active);
  let out = '';
  for (const part of parts) {
    if (!part.startsWith('{') || !part.endsWith('}')) {
      if (emitting()) {
        out += part.replace(/\[([A-Za-z_][A-Za-z_0-9]*)\]/g, (whole, name) =>
          name in vars ? formatValue(vars[name]) : whole);
      }
      continue;
    }
    const body = part.slice(1, -1).trim();
    const ctl = /^(if|elsif)\b\s*(.*)$/s.exec(body); // "{if x}" and "{if(x)}" both occur
    if (ctl && ctl[1] === 'if') {
      const parentOn = emitting();
      const cond = parentOn ? Boolean(scalar(evaluate(ctl[2], vars))) : false;
      stack.push({ active: cond, taken: cond });
    } else if (ctl) {
      const top = stack[stack.length - 1];
      if (!top) throw new TemplateError('{elsif} without {if}');
      const parentOn = stack.slice(0, -1).every((s) => s.active);
      const cond = parentOn && !top.taken ? Boolean(scalar(evaluate(ctl[2], vars))) : false;
      top.active = cond;
      top.taken = top.taken || cond;
    } else if (body === 'else') {
      const top = stack[stack.length - 1];
      if (!top) throw new TemplateError('{else} without {if}');
      top.active = !top.taken;
      top.taken = true;
    } else if (body === 'endif') {
      if (!stack.pop()) throw new TemplateError('{endif} without {if}');
    } else if (emitting()) {
      out += formatValue(evaluate(body, vars));
    }
  }
  if (stack.length) throw new TemplateError('missing {endif}');
  return out;
}
