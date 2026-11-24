import test from 'node:test';
import assert from 'node:assert/strict';

const safePath=(p)=>typeof p==='string'&&p.length<=180&&!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').some(x=>!x||x==='.'||x==='..')&&/^[-\w./]+$/.test(p);
test('workspace path validation accepts ordinary relative paths',()=>{assert.equal(safePath('src/client/App.tsx'),true);assert.equal(safePath('README.md'),true)});
test('workspace path validation rejects traversal and absolute paths',()=>{for(const p of ['../secret','src/../../etc/passwd','/etc/passwd','src\\file.js',''])assert.equal(safePath(p),false,p)});
test('dependency graph has no cycles and every dependency names an agent',()=>{const deps={analyst:[],designer:['analyst'],database:['analyst'],backend:['analyst','database'],frontend:['analyst','designer'],security:['backend','database'],devops:['backend','frontend'],qa:['frontend','backend','database','security','devops'],reviewer:['qa']};const visited=new Set();function visit(k,stack=new Set()){assert.equal(stack.has(k),false,`cycle at ${k}`);if(visited.has(k))return;stack.add(k);for(const d of deps[k]){assert.ok(Object.hasOwn(deps,d),`unknown dependency ${d}`);visit(d,stack)}stack.delete(k);visited.add(k)}Object.keys(deps).forEach(k=>visit(k));assert.equal(visited.size,9)});
