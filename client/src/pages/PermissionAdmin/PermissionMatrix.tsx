import React from 'react';

import { Switch } from '@client/src/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@client/src/components/ui/tooltip';
import { useTranslation } from '@client/src/i18n/useTranslation';

import type { ProgramCode, SubjectPermission } from '@shared/api.interface';

interface SubjectNode {
  key: string;
  name: string;
  nameEn: string;
  children?: SubjectNode[];
}

interface ProgramDef {
  program: ProgramCode;
  name: string;
  nameEn: string;
  subjects: SubjectNode[];
}

interface PermissionMatrixProps {
  programs: ProgramDef[];
  permissions: SubjectPermission[];
  isAutoGranted: (program: ProgramCode, subject: string, type: 'view' | 'upload') => boolean;
  onPermChange: (
    program: ProgramCode,
    subject: string,
    subSubject: string | undefined,
    type: 'view' | 'upload',
    value: boolean,
  ) => void;
  selectedTeacherId: string;
}

const PermissionMatrix: React.FC<PermissionMatrixProps> = ({
  programs,
  permissions,
  isAutoGranted,
  onPermChange,
  selectedTeacherId,
}) => {
  const { t, language } = useTranslation();

  const getPermValue = (
    program: ProgramCode,
    subject: string,
    subSubject: string | undefined,
    type: 'view' | 'upload',
  ): boolean => {
    const auto = isAutoGranted(program, subject, type);
    if (auto) return true;
    const found = permissions.find(
      (p) =>
        p.program === program &&
        p.subject === subject &&
        (subSubject ? p.subSubject === subSubject : !p.subSubject),
    );
    if (!found) return false;
    return type === 'view' ? found.canView : found.canUpload;
  };

  const renderRow = (
    program: ProgramCode,
    subject: SubjectNode,
    subSubject?: SubjectNode,
    indent: number = 0,
  ) => {
    const displayName = language === 'zh-CN'
      ? (subSubject ? subSubject.name : subject.name)
      : (subSubject ? subSubject.nameEn : subject.nameEn);
    const viewDisabled = isAutoGranted(program, subject.key, 'view');
    const uploadDisabled = isAutoGranted(program, subject.key, 'upload');
    const viewChecked = getPermValue(program, subject.key, subSubject?.key, 'view');
    const uploadChecked = getPermValue(program, subject.key, subSubject?.key, 'upload');

    return (
      <tr
        key={`${program}-${subject.key}-${subSubject?.key ?? 'root'}`}
        className="border-b border-border last:border-0 hover:bg-muted/30"
      >
        <td className="py-3 px-4" style={{ paddingLeft: `${16 + indent * 24}px` }}>
          <span className="text-sm text-foreground">{displayName}</span>
        </td>
        <td className="py-3 px-4 text-center w-32">
          <div className="flex items-center justify-center gap-2">
            {viewDisabled ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="inline-flex items-center">
                    <Switch checked disabled />
                  </div>
                </TooltipTrigger>
                <TooltipContent>{t('permission.autoGrantedTip')}</TooltipContent>
              </Tooltip>
            ) : (
              <Switch
                checked={viewChecked}
                onCheckedChange={(val) =>
                  onPermChange(program, subject.key, subSubject?.key, 'view', val)
                }
              />
            )}
          </div>
        </td>
        <td className="py-3 px-4 text-center w-32">
          <div className="flex items-center justify-center gap-2">
            {uploadDisabled ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="inline-flex items-center">
                    <Switch checked disabled />
                  </div>
                </TooltipTrigger>
                <TooltipContent>{t('permission.autoGrantedTip')}</TooltipContent>
              </Tooltip>
            ) : (
              <Switch
                checked={uploadChecked}
                onCheckedChange={(val) =>
                  onPermChange(program, subject.key, subSubject?.key, 'upload', val)
                }
              />
            )}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <>
      {programs.map((prog) => (
        <div key={prog.program} className="mb-6 last:mb-0">
          <h4 className="text-sm font-semibold text-primary mb-2 px-4 py-2 bg-primary/5 rounded-lg">
            {prog.name}
          </h4>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-muted/30 border-b border-border">
                  <th className="py-2 px-4 text-left text-xs font-medium text-muted-foreground w-full">
                    {language === 'zh-CN' ? '科目' : 'Subject'}
                  </th>
                  <th className="py-2 px-4 text-center text-xs font-medium text-muted-foreground w-32">
                    {t('permission.view')}
                  </th>
                  <th className="py-2 px-4 text-center text-xs font-medium text-muted-foreground w-32">
                    {t('permission.upload')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {prog.subjects.map((subj) => (
                  <React.Fragment key={subj.key}>
                    {renderRow(prog.program, subj)}
                    {subj.children?.map((child) =>
                      renderRow(prog.program, subj, child, 1),
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
};

export default PermissionMatrix;
