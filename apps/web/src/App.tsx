import { Navigate, Route, Routes } from 'react-router-dom';
import { GuestOnly, RequireRole } from './auth/guards';
import { InstructorHome } from './pages/InstructorHome';
import { ScenarioPage } from './pages/ScenarioPage';
import { InstructorSessionPage } from './pages/InstructorSessionPage';
import { TraineeSessionPage } from './pages/TraineeSessionPage';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { TraineeHome } from './pages/TraineeHome';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      <Route element={<RequireRole role="INSTRUCTOR" />}>
        <Route path="/instructor" element={<InstructorHome />} />
        <Route path="/instructor/scenarios/:id" element={<ScenarioPage />} />
        <Route path="/instructor/sessions/:id" element={<InstructorSessionPage />} />
      </Route>
      <Route element={<RequireRole role="TRAINEE" />}>
        <Route path="/trainee" element={<TraineeHome />} />
        <Route path="/session/:code" element={<TraineeSessionPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
