import { useGetDashboard, useListProjects, useCreateProject } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetDashboardQueryKey, getListProjectsQueryKey } from "@workspace/api-client-react";

export function useDashboard() {
  return useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey()
    }
  });
}

export function useProjects() {
  return useListProjects({
    query: {
      queryKey: getListProjectsQueryKey()
    }
  });
}

export function useCreatePitchProject() {
  const queryClient = useQueryClient();
  return useCreateProject({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      }
    }
  });
}
