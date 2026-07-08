'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Trash2, RefreshCw, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';

interface EnrolledPerson {
  person_name: string;
  variants: number;
  created_at: string;
}

export default function FacesPage() {
  const [people, setPeople] = useState<EnrolledPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [photoInputKey, setPhotoInputKey] = useState(0);

  const fetchPeople = useCallback(async () => {
    try {
      const res = await fetch('/api/faces');
      const data = await res.json();
      setPeople(data.people || []);
    } catch {
      toast.error('Failed to fetch enrolled faces');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPeople();
  }, [fetchPeople]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !photo) {
      toast.error('Name and photo are both required');
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('name', name.trim());
      formData.append('photo', photo);
      const res = await fetch('/api/faces', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Enrolled "${name}" (${data.variantsInserted} variants embedded)`);
      setName('');
      setPhoto(null);
      setPhotoInputKey(k => k + 1);
      fetchPeople();
    } catch (e) {
      toast.error(`Enrollment failed: ${e}`);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(personName: string) {
    if (!confirm(`Remove all enrolled photos for "${personName}"? They will be classified as intruders afterward.`)) return;
    try {
      const res = await fetch(`/api/faces/${encodeURIComponent(personName)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Removed ${personName}`);
      fetchPeople();
    } catch (e) {
      toast.error(`Failed to remove: ${e}`);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Face Enrollment</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {loading ? 'Loading...' : `${people.length} person${people.length !== 1 ? 's' : ''} enrolled`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchPeople} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="rounded-lg border border-border p-5 space-y-4">
        <h2 className="text-sm font-medium">Enroll a new person</h2>
        <p className="text-xs text-muted-foreground">
          Upload one clear, tightly-cropped photo of a face — the server automatically generates
          ~16 augmented variants (flip, small rotations, crop, low-res, brightness/contrast/gamma,
          blur, JPEG artifacts, mask/eye occlusion) and embeds each one, so matching at runtime is
          robust to CCTV lighting, compression, and partial occlusion. People not enrolled here
          are classified as &quot;intruder&quot; by any camera with Face Detection enabled.
        </p>
        <form onSubmit={handleSubmit} className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe" required />
          </div>
          <div className="space-y-1.5">
            <Label>Photo</Label>
            <Input
              key={photoInputKey}
              type="file"
              accept="image/png,image/jpeg"
              onChange={e => setPhoto(e.target.files?.[0] ?? null)}
              required
            />
          </div>
          <Button type="submit" disabled={uploading}>
            <UploadCloud className="w-4 h-4 mr-2" />
            {uploading ? 'Enrolling...' : 'Enroll'}
          </Button>
        </form>
      </div>

      {!loading && people.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground text-sm">
          No one enrolled yet. Every detected face will be classified as &quot;intruder&quot;.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Variants</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Enrolled</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {people.map(person => (
                <tr key={person.person_name} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium">{person.person_name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{person.variants}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {new Date(person.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(person.person_name)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
