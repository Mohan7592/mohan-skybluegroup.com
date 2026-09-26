import { 
  useGetProject, 
  useUpdateProject, 
  useGetProjectWorkspace, 
  useGetProjectConversation,
  useSendProjectMessage,
  getGetProjectQueryKey,
  getGetProjectWorkspaceQueryKey,
  getGetProjectConversationQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export function useProject(id: string) {
  return useGetProject(id, {
    query: {
      enabled: !!id,
      queryKey: getGetProjectQueryKey(id)
    }
  });
}

export function useProjectWorkspace(id: string) {
  return useGetProjectWorkspace(id, {
    query: {
      enabled: !!id,
      queryKey: getGetProjectWorkspaceQueryKey(id)
    }
  });
}

export function useProjectConversation(id: string) {
  return useGetProjectConversation(id, {
    query: {
      enabled: !!id,
      queryKey: getGetProjectConversationQueryKey(id)
    }
  });
}

export function useUpdatePitchProject() {
  const queryClient = useQueryClient();
  return useUpdateProject({
    mutation: {
      onSuccess: (data, variables) => {
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(variables.id) });
        queryClient.invalidateQueries({ queryKey: getGetProjectWorkspaceQueryKey(variables.id) });
      }
    }
  });
}

export function useSendCopilotMessage() {
  const queryClient = useQueryClient();
  return useSendProjectMessage({
    mutation: {
      onSuccess: (data, variables) => {
        queryClient.invalidateQueries({ queryKey: getGetProjectConversationQueryKey(variables.id) });
      }
    }
  });
}
