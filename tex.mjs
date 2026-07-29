import { create, all } from 'mathjs';
const m = create(all, { number: 'BigNumber', precision: 64 });
const exprs = ['((((1)+((2)*(3)))*(5))+(3))', '(((2)^(3))^(2))', '((1)/(3))', 'sqrt((-4))', '(((3)+(5))*(2))'];
for (const e of exprs) {
  const node = m.parse(e);
  const stripped = node.transform((n) => n.isParenthesisNode ? n.content : n);
  console.log('原始 :', e);
  console.log('  keep:', node.toTex());
  console.log('  auto:', stripped.toTex({ parenthesis: 'auto' }));
  console.log('  str :', stripped.toString({ parenthesis: 'auto' }));
  console.log('  值  :', String(stripped.compile().evaluate({})));
}
