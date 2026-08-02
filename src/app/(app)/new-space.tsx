import { AnimatedSwitch } from '@/components/ui/animated-switch';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { convexQuery } from '@convex-dev/react-query';
import { useQuery } from '@tanstack/react-query';
import { useMutation } from 'convex/react';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

// One form, two jobs: `/new-space` creates, `/new-space?id=…` edits. The form
// is keyed by the loaded space so its `useState` initializers seed once from
// the server value and a cached query refresh never overwrites in-flight edits.
export default function NewSpaceScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editing = id !== undefined;

  const { data: space, isLoading } = useQuery({
    ...convexQuery(api.spaces.getSpace, { id: (id ?? '') as Id<'spaces'> }),
    enabled: editing,
  });

  // Wait for the space before mounting the edit form so its initial state is
  // seeded from the server instead of being prefilled by an effect. Creating a
  // new space needs no load.
  if (editing && isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <SpaceForm
      key={editing ? (space?._id ?? id) : 'new'}
      editing={editing}
      space={space ?? undefined}
    />
  );
}

function SpaceForm({
  editing,
  space,
}: {
  editing: boolean;
  space?: Pick<Doc<'spaces'>, '_id' | 'name' | 'dynamic'>;
}) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const createSpace = useMutation(api.spaces.createSpace);
  const updateSpace = useMutation(api.spaces.updateSpace);

  // Seeded once per (keyed) mount: a fresh create starts dynamic on; an edit
  // starts from the loaded space. A query refresh remounts via key only if the
  // id changes, so user typing is never overwritten.
  const [name, setName] = useState(space?.name ?? '');
  // Dynamic is the marquee behavior — on by default for a new space; an edit
  // mirrors the server, treating a legacy status-less space as off.
  const [dynamic, setDynamic] = useState(editing ? space?.dynamic ?? false : true);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      if (editing && space) {
        await updateSpace({ id: space._id, name: trimmed, dynamic });
      } else {
        await createSpace({ name: trimmed, dynamic });
      }
      if (process.env.EXPO_OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.back();
    } catch {
      Alert.alert(
        editing ? 'Could not save space' : 'Could not create space',
        'Something went wrong. Try again.',
      );
      setSaving(false);
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
    >
      <Text style={styles.heading}>{editing ? 'Edit space' : 'New space'}</Text>
      <Text style={styles.subheading}>
        Give it a title — Amber will suggest a few of your saves that fit. You
        choose what sticks.
      </Text>

      <TextInput
        style={styles.nameInput}
        placeholder="Apartment shopping list"
        placeholderTextColor={theme.colors.faint}
        value={name}
        onChangeText={setName}
        autoFocus={!editing}
      />

      <View style={styles.dynamicRow}>
        <View style={styles.dynamicText}>
          <Text style={styles.dynamicLabel}>Dynamic</Text>
          <Text style={styles.dynamicHint}>
            Amber keeps suggesting things that fit
          </Text>
        </View>
        <AnimatedSwitch value={dynamic} onValueChange={setDynamic} />
      </View>

      <Pressable
        onPress={save}
        disabled={!name.trim() || saving}
        style={({ pressed }) => [
          styles.saveButton,
          (!name.trim() || saving) && { opacity: 0.4 },
          pressed && { opacity: 0.8 },
        ]}
      >
        {saving ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.saveButtonText}>
            {editing ? 'Save changes' : 'Create space'}
          </Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  nameInput: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.gap(1.5),
    fontFamily: theme.fonts.bold,
    fontSize: 17,
    color: theme.colors.foreground,
  },
  dynamicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.gap(1.5),
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.gap(1.5),
  },
  dynamicText: {
    flex: 1,
    gap: 2,
  },
  dynamicLabel: {
    fontFamily: theme.fonts.bold,
    fontSize: 15,
    color: theme.colors.foreground,
  },
  dynamicHint: {
    fontFamily: theme.fonts.regular,
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.muted,
  },
  saveButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    borderCurve: 'continuous',
    paddingVertical: theme.gap(1.75),
    alignItems: 'center',
  },
  saveButtonText: {
    fontFamily: theme.fonts.bold,
    fontSize: 16,
    color: '#fff',
  },
}));
