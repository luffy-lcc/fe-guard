#!/usr/bin/env node
import path from 'node:path'
import { startMcpServer } from '../src/mcp/server.js'

const rootIndex = process.argv.indexOf('--root')
const root = rootIndex === -1 ? process.cwd() : path.resolve(process.argv[rootIndex + 1])

startMcpServer({ root }).catch((error) => {
  console.error(`fe-guard-mcp 启动失败：${error.message}`)
  process.exitCode = 2
})
