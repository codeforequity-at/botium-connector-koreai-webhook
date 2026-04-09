import json from 'rollup-plugin-json'

export default {
  input: 'index.js',
  external: (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0'),
  output: [
    {
      file: 'dist/botium-connector-koreai-webhook-es.js',
      format: 'es',
      sourcemap: true
    },
    {
      file: 'dist/botium-connector-koreai-webhook-cjs.cjs',
      format: 'cjs',
      exports: 'default',
      sourcemap: true
    }
  ],
  plugins: [
    json()
  ]
}
