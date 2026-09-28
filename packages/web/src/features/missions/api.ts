import { api } from '../../api/client'

export async function fetchMissionsJobs(sessionId: string) {
  return api.listJobs(sessionId)
}

export async function fetchMissionJob(jobId: string) {
  return api.getJob(jobId)
}
