import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Globe, Users, FolderOpen, Home, Plus, TrendingUp } from 'lucide-react';
import CurrentLocation from './components/current-location';

async function getStats() {
  const token = process.env.ADMIN_API_TOKEN;
  // Use internal URL for server-side requests (avoid Traefik loop)
  // In Docker, use localhost:3333 (Next.js dev server port, not Traefik port 8321)
  const baseUrl = 'http://localhost:3333';
  
  try {
    const [universes, worlds, rooms, users] = await Promise.all([
      fetch(`${baseUrl}/api/admin/universes?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        // Add timeout to prevent hanging
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => ({ pagination: { total: 0 } })),
      fetch(`${baseUrl}/api/admin/worlds?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => ({ pagination: { total: 0 } })),
      fetch(`${baseUrl}/api/admin/rooms?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => ({ pagination: { total: 0 } })),
      fetch(`${baseUrl}/api/admin/users?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => ({ pagination: { total: 0 } })),
    ]);
    
    return {
      universes: universes.pagination?.total || 0,
      worlds: worlds.pagination?.total || 0,
      rooms: rooms.pagination?.total || 0,
      users: users.pagination?.total || 0,
    };
  } catch (error) {
    console.error('Error fetching stats:', error);
    return { universes: 0, worlds: 0, rooms: 0, users: 0 };
  }
}

export default async function AdminDashboard() {
  const stats = await getStats();
  
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-4xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-lg">
          Overview of your WorkAdventure universe, worlds, rooms, and users.
        </p>
      </div>
      
      {stats.universes === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="text-center pb-4">
            <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-muted">
              <Globe className="h-10 w-10 text-muted-foreground" />
            </div>
            <CardTitle className="text-2xl">Get Started</CardTitle>
            <CardDescription className="text-base mt-2">
              Create your first universe to begin organizing your WorkAdventure worlds and rooms.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center pt-2">
            <Button asChild size="lg" className="gap-2">
              <Link href="/admin/universes/new">
                <Plus className="h-5 w-5" />
                Create Your First Universe
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Link href="/admin/universes" className="group">
              <Card className="transition-all hover:shadow-lg hover:border-primary/50 h-full">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Universes</CardTitle>
                  <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                    <Globe className="h-5 w-5 text-primary" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">{stats.universes}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Total universes
                  </p>
                </CardContent>
              </Card>
            </Link>
            
            <Card className="h-full">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Worlds</CardTitle>
                <div className="h-9 w-9 rounded-full bg-blue-500/10 flex items-center justify-center">
                  <Home className="h-5 w-5 text-blue-500" />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{stats.worlds}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Total worlds
                </p>
              </CardContent>
            </Card>
            
            <Card className="h-full">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Rooms</CardTitle>
                <div className="h-9 w-9 rounded-full bg-green-500/10 flex items-center justify-center">
                  <FolderOpen className="h-5 w-5 text-green-500" />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{stats.rooms}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Total rooms
                </p>
              </CardContent>
            </Card>
            
            <Link href="/admin/users" className="group">
              <Card className="transition-all hover:shadow-lg hover:border-primary/50 h-full">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Users</CardTitle>
                  <div className="h-9 w-9 rounded-full bg-purple-500/10 flex items-center justify-center group-hover:bg-purple-500/20 transition-colors">
                    <Users className="h-5 w-5 text-purple-500" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">{stats.users}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Total users
                  </p>
                </CardContent>
              </Card>
            </Link>
          </div>

          <CurrentLocation />
        </>
      )}
    </div>
  );
}
