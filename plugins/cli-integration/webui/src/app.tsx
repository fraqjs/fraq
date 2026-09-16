import { Navigate, Route, Routes } from 'react-router';

import { CliLayout } from './layout';
import { ConfigurationPage } from './pages/configuration';
import { LogsPage } from './pages/logs';

export function App() {
  return (
    <Routes>
      <Route element={<CliLayout />}>
        <Route index element={<Navigate to="/config" replace />} />
        <Route path="config" element={<ConfigurationPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="*" element={<Navigate to="/config" replace />} />
      </Route>
    </Routes>
  );
}
