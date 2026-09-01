import { Route, Routes } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { OnboardingPage } from '../features/onboarding/OnboardingPage'
import { LibraryPage } from '../features/library/LibraryPage'
import { JobsPage } from '../features/jobs/JobsPage'
import { SearchPage } from '../features/search/SearchPage'

export function AppRoutes() {
  return <Routes><Route element={<AppShell />}><Route index element={<OnboardingPage />} /><Route path="library" element={<LibraryPage />} /><Route path="jobs" element={<JobsPage />} /><Route path="research" element={<SearchPage />} /><Route path="*" element={<OnboardingPage />} /></Route></Routes>
}
