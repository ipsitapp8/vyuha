import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppFooter } from './components/AppFooter';
import { GuestOnly, RequireRole } from './auth/guards';
import { InstructorHome } from './pages/InstructorHome';
import { ScenarioPage } from './pages/ScenarioPage';
import { InstructorSessionPage } from './pages/InstructorSessionPage';
import { CockpitPage } from './cockpit/CockpitPage';
import { AarPage } from './pages/AarPage';
import { MselAuthoringPage } from './pages/MselAuthoringPage';
import { LandingPage } from './pages/LandingPage';
import { LoginChooserPage } from './pages/LoginChooserPage';
import { LoginPage } from './pages/LoginPage';
import { ProgressIndexPage, ProgressPage } from './pages/ProgressPage';
import { RegisterPage } from './pages/RegisterPage';
import { TraineeHome } from './pages/TraineeHome';

export function App() {
  const { pathname } = useLocation();
  // The cockpit is a full-screen working view, so it carries no footer.
  const showFooter = !pathname.startsWith('/session/');
  return (
    <div className="flex min-h-dvh flex-col">
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route element={<GuestOnly />}>
          <Route path="/login" element={<LoginChooserPage />} />
          <Route path="/login/instructor" element={<LoginPage portal="INSTRUCTOR" />} />
          <Route path="/login/trainee" element={<LoginPage portal="TRAINEE" />} />
          <Route path="/register" element={<RegisterPage />} />
        </Route>
        <Route element={<RequireRole role="INSTRUCTOR" />}>
          <Route path="/instructor" element={<InstructorHome />} />
          <Route path="/instructor/scenarios/:id" element={<ScenarioPage />} />
          <Route path="/instructor/scenarios/:id/msel" element={<MselAuthoringPage />} />
          <Route path="/instructor/sessions/:id" element={<InstructorSessionPage />} />
          <Route path="/instructor/session/:id" element={<InstructorSessionPage />} />
          <Route path="/aar/:sessionId" element={<AarPage />} />
        </Route>
        <Route element={<RequireRole />}>
          <Route path="/progress" element={<ProgressIndexPage />} />
          <Route path="/progress/:userId" element={<ProgressPage />} />
        </Route>
        <Route element={<RequireRole role="TRAINEE" />}>
          <Route path="/trainee" element={<TraineeHome />} />
          <Route path="/session/:code" element={<CockpitPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {showFooter ? (
        <div className="mt-auto">
          <AppFooter />
        </div>
      ) : null}
    </div>
  );
}
