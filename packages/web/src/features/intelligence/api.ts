import { api } from '../../api/client'

export async function fetchKnowledgeGraph(limit = 100) {
  return api.getKnowledgeGraph(limit)
}

export async function fetchMemoryEntries() {
  return api.getKnowledgeGraph(50)
}
