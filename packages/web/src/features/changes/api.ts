import { api } from '../../api/client'

export async function fetchChanges() {
  return api.listSnapshots('')
}
