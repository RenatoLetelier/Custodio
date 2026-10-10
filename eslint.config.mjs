import eslintReact from '@eslint-react/eslint-plugin'
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const EXEC_FILE_ONLY = 'Usa execFile con argumentos en arreglo.'
const NO_SHELL = {
  selector: 'Property[key.name="shell"][value.value=true]',
  message: 'Nada de shell: usa execFile con argumentos en arreglo.'
}

const serviceImports = {
  paths: [
    { name: 'node:child_process', importNames: ['exec', 'execSync'], message: EXEC_FILE_ONLY },
    { name: 'child_process', importNames: ['exec', 'execSync'], message: EXEC_FILE_ONLY }
  ]
}

const FORBIDDEN_IN_CORE = /localcloud|blob|supabase/i
const NOT_IN_CORE = 'src/core no puede mencionar localcloud, blob ni supabase.'
const VIA_PORT = 'src/core no toca el sistema: usa un puerto.'

const coreImports = {
  paths: ['node:child_process', 'child_process', 'node:fs', 'fs', 'node:fs/promises', 'fs/promises', 'node:sqlite', 'fastify'].map(
    (name) => ({ name, message: VIA_PORT })
  ),
  patterns: [
    { group: ['**/adapters/**', '**/api/**', '**/db/**', '**/helper/**'], message: 'src/core solo depende de sus puertos.' },
    { regex: FORBIDDEN_IN_CORE.source, caseSensitive: false, message: NOT_IN_CORE }
  ]
}

const coreMentions = ['Identifier[name=%]', 'Literal[value=%]', 'TemplateElement[value.raw=%]'].map((selector) => ({
  selector: selector.replace('%', `/${FORBIDDEN_IN_CORE.source}/i`),
  message: NOT_IN_CORE
}))

// Interface text comes only from es.json: no letters in JSX text, string children or text-bearing props
const HAS_LETTERS = '/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/'
const NOT_FROM_CATALOG = 'Texto de interfaz fijo: usa t() con una clave de es.json.'
const noHardcodedText = [
  `JSXText[value=${HAS_LETTERS}]`,
  `JSXExpressionContainer > Literal[value=${HAS_LETTERS}]`,
  `JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=${HAS_LETTERS}]`,
  `JSXAttribute[name.name=/^(aria-label|aria-description|title|placeholder|alt)$/] > Literal`
].map((selector) => ({ selector, message: NOT_FROM_CATALOG }))

const uiFiles = ['packages/custodio-ui/src/ui/**/*.{ts,tsx}']

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/test-results/**', '**/playwright-report/**', 'reports/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    }
  },
  { files: ['**/*.{js,mjs,cjs}'], ...tseslint.configs.disableTypeChecked },
  {
    files: ['packages/custodio-service/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', serviceImports],
      'no-restricted-syntax': ['error', NO_SHELL]
    }
  },
  {
    files: ['packages/custodio-service/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', coreImports],
      'no-restricted-syntax': ['error', NO_SHELL, ...coreMentions]
    }
  },
  {
    // Tests read untyped JSON bodies; their shape is checked against openapi.yaml instead
    files: ['**/test/**/*.ts', '**/*.test.{ts,tsx}', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off'
    }
  },
  { files: uiFiles, ...eslintReact.configs['recommended-type-checked'] },
  { files: uiFiles, ...reactHooks.configs.flat['recommended-latest'] },
  {
    files: uiFiles,
    ignores: ['**/*.test.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    rules: { 'no-restricted-syntax': ['error', ...noHardcodedText] }
  }
)
