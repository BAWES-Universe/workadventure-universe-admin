import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Globe, Users, FolderOpen, Home, Plus, MapPin } from 'lucide-react';
import { prisma } from '@/lib/db';
import { cn } from '@/lib/utils';
import CurrentLocation from './components/current-location';
import PendingInvitationsAlert from './components/pending-invitations-alert';
import RecentlyVisited from './components/recently-visited';

async function getStats() {
  const token = process.env.ADMIN_API_TOKEN;
  // Use internal URL for server-side requests (avoid Traefik loop)
  // In Docker, use localhost:3333 (Next.js dev server port, not Traefik port 8321)
  const baseUrl = 'http://localhost:3333';
  
  try {
    const [universes, worlds, rooms, users, defaultUniverse, defaultWorld, defaultRoom, systemUser] = await Promise.all([
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
      // Check if default/default/default items exist
      prisma.universe.findUnique({ where: { slug: 'default' } }).catch(() => null),
      prisma.world.findFirst({
        where: {
          slug: 'default',
          universe: { slug: 'default' },
        },
      }).catch(() => null),
      prisma.room.findFirst({
        where: {
          slug: 'default',
          world: {
            slug: 'default',
            universe: { slug: 'default' },
          },
        },
      }).catch(() => null),
      prisma.user.findUnique({ where: { email: 'system@workadventure.local' } }).catch(() => null),
    ]);
    
    const universeTotal = universes.pagination?.total || 0;
    const worldTotal = worlds.pagination?.total || 0;
    const roomTotal = rooms.pagination?.total || 0;
    const userTotal = users.pagination?.total || 0;
    
    // Subtract 1 from each count if the default items exist
    return {
      universes: Math.max(0, universeTotal - (defaultUniverse ? 1 : 0)),
      worlds: Math.max(0, worldTotal - (defaultWorld ? 1 : 0)),
      rooms: Math.max(0, roomTotal - (defaultRoom ? 1 : 0)),
      users: Math.max(0, userTotal - (systemUser ? 1 : 0)),
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
      <PendingInvitationsAlert />

      {/* Current location at the top */}
      <CurrentLocation />

      {/* Discover / onboarding section */}
      {stats.universes === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="text-center pb-4">
            <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-muted">
              <Globe className="h-10 w-10 text-muted-foreground" />
            </div>
            <CardTitle className="text-2xl">Get Started</CardTitle>
            <CardDescription className="text-base mt-2">
              Create your first universe to begin organizing your Universe worlds and rooms.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center pt-2">
            <Button variant="default" asChild size="lg" className="gap-2">
              <Link href="/admin/universes/new">
                <Plus className="h-5 w-5" />
                Create Your First Universe
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">Discover</h2>
            <p className="text-sm text-muted-foreground">
              Explore universes, worlds, rooms, and users across the Universe.
            </p>
          </div>
          <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
            <Link href="/admin/discover/universes" className="group block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              <Card className={cn(
                'relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                'hover:-translate-y-1 hover:shadow-lg',
              )}>
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-indigo-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
                <CardHeader className="relative flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Universes</CardTitle>
                  <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                    <Globe className="h-5 w-5 text-primary" />
                  </div>
                </CardHeader>
                <CardContent className="relative">
                  <div className="text-3xl font-bold">{stats.universes}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Public universes you can explore
                  </p>
                </CardContent>
              </Card>
            </Link>

            <Link href="/admin/discover/worlds" className="group block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              <Card className={cn(
                'relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                'hover:-translate-y-1 hover:shadow-lg',
              )}>
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-purple-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
                <CardHeader className="relative flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Worlds</CardTitle>
                  <div className="h-9 w-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover:bg-blue-500/20 transition-colors">
                    <Home className="h-5 w-5 text-blue-500" />
                  </div>
                </CardHeader>
                <CardContent className="relative">
                  <div className="text-3xl font-bold">{stats.worlds}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Worlds across universes
                  </p>
                </CardContent>
              </Card>
            </Link>

            <Link href="/admin/discover/rooms" className="group block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              <Card className={cn(
                'relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                'hover:-translate-y-1 hover:shadow-lg',
              )}>
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-green-500/10 via-transparent to-emerald-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
                <CardHeader className="relative flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Rooms</CardTitle>
                  <div className="h-9 w-9 rounded-full bg-green-500/10 flex items-center justify-center group-hover:bg-green-500/20 transition-colors">
                    <FolderOpen className="h-5 w-5 text-green-500" />
                  </div>
                </CardHeader>
                <CardContent className="relative">
                  <div className="text-3xl font-bold">{stats.rooms}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Individual spaces & maps
                  </p>
                </CardContent>
              </Card>
            </Link>

            <Link href="/admin/users" className="group block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              <Card className={cn(
                'relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                'hover:-translate-y-1 hover:shadow-lg',
              )}>
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-purple-500/10 via-transparent to-pink-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
                <CardHeader className="relative flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Users</CardTitle>
                  <div className="h-9 w-9 rounded-full bg-purple-500/10 flex items-center justify-center group-hover:bg-purple-500/20 transition-colors">
                    <Users className="h-5 w-5 text-purple-500" />
                  </div>
                </CardHeader>
                <CardContent className="relative">
                  <div className="text-3xl font-bold">{stats.users}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    People exploring the Universe
                  </p>
                </CardContent>
              </Card>
            </Link>
          </div>
        </section>
      )}

      {/* Recently visited rooms */}
      <RecentlyVisited />
    </div>
  );
}
