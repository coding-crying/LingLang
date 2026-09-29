// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Button, Input, Label, Modal, TextArea, TextField } from '@heroui/react';
import { Check, FileText, Film, Link, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { LANGUAGE_NAMES } from '../hooks/useOnboarding';
import { apiFetch } from '../lib/api';
import {
  MATERIAL_FILE_ACCEPT,
  type UploadMaterialKind,
  isYouTubeUrl,
  materialFileKind,
  materialPayload,
  validateMaterialFile,
} from '../lib/materials';

type Mode = 'link' | 'text' | 'file' | 'movie';
const MODES = [
  { id: 'link', label: 'Link', icon: Link },
  { id: 'text', label: 'Text', icon: FileText },
  { id: 'file', label: 'File', icon: Upload },
  { id: 'movie', label: 'Movie', icon: Film },
] as const;

export default function AddMaterialDialog({
  onClose,
  onAdded,
  targetLang,
}: {
  onClose: () => void;
  onAdded: (sourceId: string) => void;
  targetLang: string;
}) {
  const [mode, setMode] = useState<Mode>('link');
  const [values, setValues] = useState({ link: '', text: '', movie: '' });
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState(targetLang);
  const [file, setFile] = useState<File | null>(null);
  const [fileKind, setFileKind] = useState<UploadMaterialKind>('text');
  const [textKind, setTextKind] = useState<UploadMaterialKind>('text');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const chooseFile = async (files: FileList | null) => {
    setError(null);
    if (!files?.length) return;
    if (files.length > 1) {
      setError('Choose one file at a time.');
      return;
    }
    const selected = files[0];
    setFile(null);
    setReading(true);
    try {
      await validateMaterialFile(selected);
      setFile(selected);
      setFileKind(materialFileKind(selected.name));
    } catch (err) {
      setError(
        err instanceof TypeError
          ? 'This file is not UTF-8 text. Export it as a UTF-8 text file and try again.'
          : err instanceof Error
            ? err.message
            : 'Could not read this file.',
      );
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || reading) return;
    setError(null);
    const ref = mode === 'file' ? '' : values[mode].trim();
    if (mode === 'file' ? !file : !ref) {
      setError(mode === 'file' ? 'Choose a file first.' : 'Add your material first.');
      return;
    }
    if (mode === 'link' && !isYouTubeUrl(ref)) {
      setError(
        'Enter a YouTube link. For an article or another website, paste its text in the Text tab.',
      );
      return;
    }
    setBusy(true);
    try {
      const uploadTitle = title.trim() || file?.name.replace(/\.[^.]+$/, '') || '';
      const query = new URLSearchParams({ language, title: uploadTitle, kind: fileKind });
      const response =
        mode === 'file' && file
          ? await apiFetch(`/api/content-sources/upload?${query}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'X-File-Name': encodeURIComponent(file.name),
              },
              body: file,
            })
          : await apiFetch('/api/content-sources', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: materialPayload({
                kind: mode === 'link' ? 'youtube' : mode === 'movie' ? 'movie' : textKind,
                language,
                ref,
                title: title.trim() || undefined,
                ...(mode === 'text' && textKind !== 'text' ? { inputType: 'text' as const } : {}),
              }),
            });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          body.error ||
            (response.status === 413
              ? 'This material is too large. Try a shorter passage.'
              : 'Could not add this material. Try again.'),
        );
      }
      const source = await response.json();
      onAdded(source.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this material.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => !open && !busy && !reading && onClose()}
      isDismissable={!busy && !reading}
    >
      <Modal.Container placement="auto">
        <Modal.Dialog className="material-dialog">
          <Modal.CloseTrigger isDisabled={busy || reading} />
          <Modal.Header>
            <span className="dialog-eyebrow">YOUR LIBRARY</span>
            <Modal.Heading>Add material</Modal.Heading>
          </Modal.Header>
          <form onSubmit={submit}>
            <Modal.Body className="material-dialog-body">
              <div className="add-mode-picker" role="group" aria-label="Material type">
                {MODES.map(({ id, label, icon: Icon }) => (
                  <Button
                    key={id}
                    variant="ghost"
                    aria-pressed={mode === id}
                    isDisabled={busy || reading}
                    className={mode === id ? 'add-mode active' : 'add-mode'}
                    onPress={() => {
                      setMode(id);
                      setError(null);
                    }}
                  >
                    <Icon size={19} aria-hidden="true" />
                    {label}
                  </Button>
                ))}
              </div>
              {mode === 'file' ? (
                <div
                  className={`file-drop-zone${dragging ? ' dragging' : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!busy && !reading) setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    if (!busy && !reading) void chooseFile(event.dataTransfer.files);
                  }}
                >
                  <input
                    ref={fileInput}
                    type="file"
                    className="sr-only"
                    tabIndex={-1}
                    accept={MATERIAL_FILE_ACCEPT}
                    aria-label="Upload material file"
                    disabled={busy || reading}
                    onChange={(event) => void chooseFile(event.target.files)}
                  />
                  {file ? (
                    <>
                      <span className="file-ready-icon">
                        <Check size={24} />
                      </span>
                      <strong>{file.name}</strong>
                      <span>{Math.max(1, Math.round(file.size / 1024))} KB</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        isDisabled={busy || reading}
                        onPress={() => setFile(null)}
                      >
                        <X size={16} />
                        Remove file
                      </Button>
                    </>
                  ) : (
                    <>
                      <Upload size={28} aria-hidden="true" />
                      <strong>{reading ? 'Reading file...' : 'Drop your file here'}</strong>
                      <span>PDF up to 50 MB · TXT, Markdown, SRT, VTT up to 5 MB</span>
                      <Button
                        variant="secondary"
                        isDisabled={busy || reading}
                        onPress={() => fileInput.current?.click()}
                      >
                        Choose file
                      </Button>
                    </>
                  )}
                </div>
              ) : (
                <TextField
                  value={values[mode]}
                  onChange={(value) => setValues((prev) => ({ ...prev, [mode]: value }))}
                  isDisabled={busy}
                  isRequired
                >
                  <Label>
                    {mode === 'link'
                      ? 'YouTube link'
                      : mode === 'movie'
                        ? 'Movie title'
                        : 'Your text'}
                  </Label>
                  {mode === 'text' ? (
                    <TextArea
                      autoFocus
                      rows={7}
                      placeholder="Paste an article, a story, lyrics, or a word list..."
                    />
                  ) : (
                    <Input
                      autoFocus
                      type={mode === 'link' ? 'url' : 'text'}
                      placeholder={
                        mode === 'link' ? 'https://youtube.com/watch?v=...' : 'Movie title and year'
                      }
                    />
                  )}
                </TextField>
              )}
              {(mode === 'text' || (mode === 'file' && file)) && (
                <label className="material-language-field">
                  <span>What is this material?</span>
                  <select
                    value={mode === 'file' ? fileKind : textKind}
                    disabled={
                      busy || reading || (mode === 'file' && /\.pdf$/i.test(file?.name ?? ''))
                    }
                    onChange={(event) =>
                      (mode === 'file' ? setFileKind : setTextKind)(
                        event.target.value as UploadMaterialKind,
                      )
                    }
                  >
                    <option value="text">Article, story, or notes</option>
                    <option value="textbook">Textbook or course chapters</option>
                    <option value="movie">Movie or episode transcript</option>
                  </select>
                </label>
              )}
              <p className="material-detail-note material-import-help">
                {mode === 'link'
                  ? 'We use the video transcript and keep timestamps so you can choose where to begin.'
                  : mode === 'movie'
                    ? 'We will look for subtitles in the selected language. For a specific movie or episode version, upload its SRT or VTT file.'
                    : mode === 'file'
                      ? 'Use a PDF with selectable text. Chapter headings and subtitle timestamps help us keep your place.'
                      : 'Keep chapter headings or transcript timestamps when you paste them.'}{' '}
                After import, choose your starting point and tell us what you understand.
              </p>
              <div className="material-form-details">
                <TextField value={title} onChange={setTitle} isDisabled={busy}>
                  <Label>
                    Title <span className="optional-label">(optional)</span>
                  </Label>
                  <Input placeholder={file?.name.replace(/\.[^.]+$/, '') || 'Give it a name'} />
                </TextField>
                <label className="material-language-field">
                  <span>Language</span>
                  <select
                    value={language}
                    disabled={busy}
                    onChange={(event) => setLanguage(event.target.value)}
                  >
                    {Object.entries(LANGUAGE_NAMES).map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {error && (
                <p role="alert" className="material-form-error">
                  {error}
                </p>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" isDisabled={busy || reading} onPress={onClose}>
                Cancel
              </Button>
              <Button type="submit" isPending={busy} isDisabled={reading}>
                <Upload size={16} />
                {busy ? 'Adding...' : 'Add to library'}
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
