import tseslint from 'typescript-eslint'
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.turbo/**'] },
  ...tseslint.configs.recommended,
  { languageOptions: { parserOptions: { projectService: true } } }
)
