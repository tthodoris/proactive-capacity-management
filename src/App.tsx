import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { AppProvider } from './context/AppContext'
import { AdminPage } from './pages/AdminPage'
import { AlertsPage } from './pages/AlertsPage'
import { ConnectPage } from './pages/ConnectPage'
import { ConstraintDetailPage } from './pages/ConstraintDetailPage'
import { ConstraintsPage } from './pages/ConstraintsPage'
import { CustomerDetailPage, CustomersPage } from './pages/CustomersPage'
import { CustomerRiskPage } from './pages/CustomerRiskPage'
import { CustomerRiskDetailPage } from './pages/CustomerRiskDetailPage'
import { DashboardPage } from './pages/DashboardPage'
import { InventoryPage } from './pages/InventoryPage'
import { NewConstraintPage } from './pages/NewConstraintPage'
import { QuotaGroupsPage } from './pages/QuotaGroupsPage'
import { QuotasPage } from './pages/QuotasPage'
import { RegionCostAnalysisPage } from './pages/RegionCostAnalysisPage'
import { RegionEvaluationPage } from './pages/RegionEvaluationPage'
import { RegionEvaluationsPage } from './pages/RegionEvaluationsPage'
import { ReportsPage } from './pages/ReportsPage'
import { RewardsPage } from './pages/RewardsPage'

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="connect" element={<ConnectPage />} />
            <Route path="constraints" element={<ConstraintsPage />} />
            <Route path="constraints/new" element={<NewConstraintPage />} />
            <Route path="constraints/:id" element={<ConstraintDetailPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="customers/risk" element={<CustomerRiskPage />} />
            <Route path="customers/risk/:id" element={<CustomerRiskDetailPage />} />
            <Route path="customers/:id" element={<CustomerDetailPage />} />
            <Route path="inventory" element={<InventoryPage />} />
            <Route path="quotas" element={<QuotasPage />} />
            <Route path="quota-groups" element={<QuotaGroupsPage />} />
            <Route path="region-evaluation" element={<RegionEvaluationPage />} />
            <Route path="region-evaluation/history" element={<RegionEvaluationsPage />} />
            <Route path="region-evaluation/cost-analysis" element={<RegionCostAnalysisPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="rewards" element={<RewardsPage />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  )
}
