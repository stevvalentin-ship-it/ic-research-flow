import { HashRouter } from 'react-router-dom'
import { AppRoutes } from './routes'
import { ErrorBoundary } from '../components/ErrorBoundary'

export function App() { return <ErrorBoundary><HashRouter><AppRoutes /></HashRouter></ErrorBoundary> }
