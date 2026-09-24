import React from 'react';
import { Route, Routes } from 'react-router-dom';

import Layout from './components/Layout';
import NotFound from './pages/NotFound/NotFound';
import HomePage from './pages/Home/HomePage';
import PreKHomePage from './pages/PreKHome/PreKHomePage';
import KHomePage from './pages/KHome/KHomePage';
import SubjectPage from './pages/Subject/SubjectPage';
import MontessoriPage from './pages/Montessori/MontessoriPage';
import ChinesePage from './pages/Chinese/ChinesePage';
import EnglishPage from './pages/English/EnglishPage';
import PEPage from './pages/PE/PEPage';
import UploadPage from './pages/Upload/UploadPage';
import MyResourcesPage from './pages/MyResources/MyResourcesPage';
import ReviewPage from './pages/Review/ReviewPage';
import TeacherAdminPage from './pages/TeacherAdmin/TeacherAdminPage';
import PermissionAdminPage from './pages/PermissionAdmin/PermissionAdminPage';
import AuditLogPage from './pages/AuditLog/AuditLogPage';
import LoginPage from './pages/Login/LoginPage';
import UnauthorizedPage from './pages/Unauthorized/UnauthorizedPage';
import ChangePasswordPage from './pages/ChangePassword/ChangePasswordPage';

import { LanguageProvider } from './i18n/i18n-context';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { AuthProvider } from './auth/auth-context';
import { ProtectedRoute } from './auth/ProtectedRoute';
import type { RoleCode } from '@shared/api.interface';

const TEACHER_ROLES: RoleCode[] = [
  'principal',
  'curriculum_director',
  'prek_head',
  'k_head',
  'pe_specialist',
  'prek_assistant',
  'k_assistant',
];

const UPLOAD_ROLES: RoleCode[] = [
  'principal',
  'curriculum_director',
  'prek_head',
  'k_head',
  'pe_specialist',
];

const REVIEW_ROLES: RoleCode[] = ['principal', 'curriculum_director'];

const ADMIN_ROLES: RoleCode[] = ['principal'];

const RoutesComponent = () => {
  return (
    <LanguageProvider>
      <AuthProvider>
        <AppErrorBoundary>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/unauthorized" element={<UnauthorizedPage />} />

            {/* Protected routes with layout */}
            <Route
              element={
                <ProtectedRoute requiredRoles={TEACHER_ROLES}>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route index element={<HomePage />} />

              <Route path="prek" element={<PreKHomePage />} />
              <Route path="prek/virtue" element={<SubjectPage />} />
              <Route path="prek/montessori" element={<MontessoriPage />} />
              <Route path="prek/montessori/:sub" element={<SubjectPage />} />
              <Route path="prek/pe" element={<SubjectPage />} />

              <Route path="k" element={<KHomePage />} />
              <Route path="k/virtue" element={<SubjectPage />} />
              <Route path="k/chinese" element={<ChinesePage />} />
              <Route path="k/chinese/:sub" element={<SubjectPage />} />
              <Route path="k/english" element={<EnglishPage />} />
              <Route path="k/english/:theme" element={<SubjectPage />} />
              <Route path="k/pe" element={<PEPage />} />
              <Route path="k/pe/:sub" element={<SubjectPage />} />

              {/* Upload */}
              <Route
                path="upload"
                element={
                  <ProtectedRoute requiredRoles={UPLOAD_ROLES}>
                    <UploadPage />
                  </ProtectedRoute>
                }
              />
              <Route path="my-resources" element={<MyResourcesPage />} />

              {/* Review */}
              <Route
                path="review"
                element={
                  <ProtectedRoute requiredRoles={REVIEW_ROLES}>
                    <ReviewPage />
                  </ProtectedRoute>
                }
              />

              {/* Admin */}
              <Route
                path="admin/teachers"
                element={
                  <ProtectedRoute requiredRoles={ADMIN_ROLES}>
                    <TeacherAdminPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/permissions"
                element={
                  <ProtectedRoute requiredRoles={ADMIN_ROLES}>
                    <PermissionAdminPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/audit"
                element={
                  <ProtectedRoute requiredRoles={ADMIN_ROLES}>
                    <AuditLogPage />
                  </ProtectedRoute>
                }
              />

              {/* Change password */}
              <Route path="change-password" element={<ChangePasswordPage />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppErrorBoundary>
      </AuthProvider>
    </LanguageProvider>
  );
};

export default RoutesComponent;
