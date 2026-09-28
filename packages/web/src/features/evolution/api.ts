import { api } from '../../api/client'

export async function fetchEvolutionProposals(state?: string) {
  return api.listProposals(state)
}

export async function advanceProposal(id: string) {
  return api.advanceProposal(id)
}

export async function promoteProposal(id: string) {
  return api.promoteProposal(id)
}

export async function rollbackProposal(id: string, reason: string) {
  return api.rollbackProposal(id, reason)
}
