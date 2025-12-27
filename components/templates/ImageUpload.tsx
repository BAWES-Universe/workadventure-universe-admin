'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Upload, X, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ImageUploadProps {
  value: string;
  onChange: (url: string) => void;
  mapId?: string;
  templateId?: string;
  disabled?: boolean;
  className?: string;
  deferUpload?: boolean; // If true, only show local preview and call onFileChange with File object
  onFileChange?: (file: File | null) => void; // Called when file is selected (for deferred upload)
}

export function ImageUpload({ value, onChange, mapId, templateId, disabled, className, deferUpload = false, onFileChange }: ImageUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(value || null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Update preview when value changes externally
  useEffect(() => {
    setPreview(value || null);
  }, [value]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      setError('Invalid file type. Only images (JPEG, PNG, WebP, GIF) are allowed.');
      return;
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      setError('File size exceeds 5MB limit.');
      return;
    }

    setError(null);

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreview(reader.result as string);
    };
    reader.readAsDataURL(file);

    if (deferUpload) {
      // Store file for deferred upload
      setPendingFile(file);
      if (onFileChange) {
        onFileChange(file);
      }
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    // Upload immediately (original behavior)
    setUploading(true);

    try {
      // Upload to server
      const formData = new FormData();
      formData.append('file', file);
      if (mapId) {
        formData.append('mapId', mapId);
      }
      if (templateId) {
        formData.append('templateId', templateId);
      }

      const { authenticatedFetch } = await import('@/lib/client-auth');
      authenticatedFetch('/api/admin/templates/maps/upload-image', {
        method: 'POST',
        body: formData,
      }).then(async (response: Response) => {
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Upload failed');
        }

        const data = await response.json();
        onChange(data.url);
        setError(null);
      }).catch((err: Error) => {
        setError(err.message || 'Upload failed');
        setPreview(null);
      }).finally(() => {
        setUploading(false);
        // Reset file input
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setUploading(false);
    }
  };

  const handleRemove = () => {
    onChange('');
    setPreview(null);
    setError(null);
    setPendingFile(null);
    if (onFileChange) {
      onFileChange(null);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Reset file input when label is clicked (for replace functionality)
  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;

    const handleLabelClick = () => {
      // Reset the input value to allow selecting the same file again
      input.value = '';
    };

    // Listen for focus events which happen when label is clicked
    input.addEventListener('focus', handleLabelClick);
    
    return () => {
      input.removeEventListener('focus', handleLabelClick);
    };
  }, []);

  const fileInputId = `file-input-${mapId || templateId || 'upload'}`;

  return (
    <div className={cn('space-y-2', className)}>
      <Label>Preview Image</Label>
      
      {/* File input - always present but hidden */}
      <input
        id={fileInputId}
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        disabled={disabled || uploading}
      />
      
      {preview ? (
        <div className="relative group">
          <div className="relative w-full h-48 border rounded-lg overflow-hidden bg-muted">
            <img
              src={preview}
              alt="Preview"
              className="w-full h-full object-contain pointer-events-none"
            />
            {!disabled && (
              <div 
                className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 z-10"
              >
                <label htmlFor={fileInputId} style={{ margin: 0 }}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    asChild
                    disabled={uploading || disabled}
                  >
                    <span>
                      <Upload className="h-4 w-4 mr-2" />
                      Replace
                    </span>
                  </Button>
                </label>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleRemove}
                  disabled={uploading}
                >
                  <X className="h-4 w-4 mr-2" />
                  Remove
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          className={cn(
            'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
            disabled || uploading
              ? 'bg-muted cursor-not-allowed opacity-50'
              : 'bg-muted/50 hover:bg-muted border-muted-foreground/25 hover:border-muted-foreground/50'
          )}
          onClick={() => !disabled && !uploading && fileInputRef.current?.click()}
        >
          {uploading ? (
            <>
              <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Uploading...</p>
            </>
          ) : (
            <>
              <ImageIcon className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm font-medium mb-1">Click to upload</p>
              <p className="text-xs text-muted-foreground">PNG, JPG, WebP, GIF up to 5MB</p>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {value && !preview && (
        <div className="text-xs text-muted-foreground">
          Current URL: <span className="font-mono break-all">{value}</span>
        </div>
      )}
    </div>
  );
}

