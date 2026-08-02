import { AnimatedSwitch } from '@/components/ui/animated-switch';
import { EmptyState } from '@/components/empty-state';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { convexQuery } from '@convex-dev/react-query';
import { useQuery } from '@tanstack/react-query';
import { useMutation } from 'convex/react';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

// Per-space membership toggles for one item. Every write here is the user's
// hand — `saved` rows only; flipping a space on also overrides a dismissal.
export default function ManageSpacesScreen() {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  const id = itemId as Id<'items'>;

  const { data: spaces } = useQuery(convexQuery(api.spaces.listSpaces, {}));
  const { data: item } = useQuery(convexQuery(api.items.getItem, { id }));

  const addItemToSpace = useMutation(api.spaces.addItemToSpace);
  const removeItemFromSpace = useMutation(api.spaces.removeItemFromSpace);

  // Optimistic overrides are keyed by item so a route-param change cannot
  // apply the previous item's toggles to the next item. Server-side changes
  // from another flow (e.g. a background suggestion accept) are not reconciled
  // for the active item.
  const [override, setOverride] = useState<{
    itemId: Id<'items'>;
    values: Map<Id<'spaces'>, boolean>;
  } | null>(null);
  const activeOverride = override?.itemId === id ? override.values : null;
  const serverMembers = useMemo(
    () => new Set((item?.spaces ?? []).map((s) => s._id)),
    [item],
  );
  const members = useMemo(() => {
    if (!activeOverride) return serverMembers;
    const set = new Set(serverMembers);
    for (const [spaceId, on] of activeOverride) {
      if (on) set.add(spaceId);
      else set.delete(spaceId);
    }
    return set;
  }, [activeOverride, serverMembers]);

  const toggle = (spaceId: Id<'spaces'>, next: boolean) => {
    setOverride((current) => {
      const values = new Map(current?.itemId === id ? current.values : []);
      values.set(spaceId, next);
      return { itemId: id, values };
    });
    if (next) addItemToSpace({ itemId: id, spaceId });
    else removeItemFromSpace({ itemId: id, spaceId });
  };

  // The item may be `null` (deleted, or not ours) — distinct from `undefined`
  // (still loading). A null item renders a non-interactive state instead of an
  // all-off switch list, since every toggle would fire a failing mutation.
  const loading = spaces === undefined || item === undefined;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Spaces</Text>
      <Text style={styles.subheading}>Choose where this save lives.</Text>

      {loading ? (
        <ActivityIndicator style={styles.spinner} />
      ) : item === null ? (
        <EmptyState title="Unavailable" message="This save is unavailable." />
      ) : spaces.length === 0 ? (
        <Text style={styles.empty}>
          No spaces yet — create one from the Spaces tab.
        </Text>
      ) : (
        <View style={styles.list}>
          {spaces.map((space) => (
            <View key={space._id} style={styles.row}>
              <Text style={styles.rowLabel} numberOfLines={1}>
                {space.name}
              </Text>
              <AnimatedSwitch
                value={members.has(space._id)}
                onValueChange={(next) => toggle(space._id, next)}
              />
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    padding: theme.gap(2.5),
    gap: theme.gap(1.5),
  },
  heading: {
    fontFamily: theme.fonts.display,
    fontSize: 24,
    color: theme.colors.foreground,
  },
  subheading: {
    fontFamily: theme.fonts.regular,
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.muted,
  },
  spinner: {
    marginVertical: theme.gap(3),
  },
  empty: {
    fontFamily: theme.fonts.regular,
    fontSize: 14,
    color: theme.colors.muted,
    marginVertical: theme.gap(2),
  },
  list: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.gap(1.5),
    paddingVertical: theme.gap(1.5),
    paddingHorizontal: theme.gap(1.5),
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowLabel: {
    flex: 1,
    fontFamily: theme.fonts.medium,
    fontSize: 15,
    color: theme.colors.foreground,
  },
}));
