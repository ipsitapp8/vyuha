import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppFooter } from './components/AppFooter';
import { GuestOnly, RequireRole } from './auth/guards';
import { CockpitPage } from './cockpit/CockpitPage';
import { LandingPage } from './pages/LandingPage';
import { LoginChooserPage } from './pages/LoginChooserPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { TraineeHome } from './pages/TraineeHome';

// Instructor, review and progress screens are loaded on demand: a trainee never downloads the God View,
// the MSEL editor or the chart library, and the first paint ships a much smaller bundle.
const InstructorHome = lazy(() =>
  import('./pages/InstructorHome').then((m) => ({ default: m.InstructorHome })),
);
const ScenarioPage = lazy(() =>
  import('./pages/ScenarioPage').then((m) => ({ default: m.ScenarioPage })),
);
const MselAuthoringPage = lazy(() =>
  import('./pages/MselAuthoringPage').then((m) => ({ default: m.MselAuthoringPage })),
);
const InstructorSessionPage = lazy(() =>
  import('./pages/InstructorSessionPage').then((m) => ({ default: m.InstructorSessionPage })),
);
const AarPage = lazy(() => import('./pages/AarPage').then((m) => ({ default: m.AarPage })));
const ProgressIndexPage = lazy(() =>
  import('./pages/ProgressPage').then((m) => ({ default: m.ProgressIndexPage })),
);
const ProgressPage = lazy(() =>
  import('./pages/ProgressPage').then((m) => ({ default: m.ProgressPage })),
);

function PageLoading() {
  const { t } = useTranslation();
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <p role="status" className="text-muted-foreground">
        {t('common.loading')}
      </p>
    </main>
  );
}

export function App() {
  const { pathname } = useLocation();
  // The cockpit is a full-screen working view, so it carries no footer.
  const showFooter = !pathname.startsWith('/session/');
  return (
    <div className="flex min-h-dvh flex-col">
      <Suspense fallback={<PageLoading />}>
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
      </Suspense>
      {showFooter ? (
        <div className="mt-auto">
          <AppFooter />
        </div>
      ) : null}
    </div>
  );
}
