import { api } from '../../api/client'

export async function fetchWorkSessions() {
  return api.listSessions()
}

export async function fetchWorkSession(id: string) {
  return api.getSession(id)
}
