const f = require('fs')
const content = '#!/usr/bin/env node\nrequire("../vite/bin/vite.js")'
f.writeFileSync('packages/web/node_modules/.bin/vite', content)
f.writeFileSync('packages/tui/node_modules/.bin/vite', content)
f.chmodSync('packages/web/node_modules/.bin/vite', 0o755)
f.chmodSync('packages/tui/node_modules/.bin/vite', 0o755)
console.log('ok')
