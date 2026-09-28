import { api } from '../../api/client'

export async function fetchSystemHealth() {
  return api.health()
}

export async function fetchGatewayHealth() {
  return api.getGatewayHealth()
}
